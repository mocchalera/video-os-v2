# Code Review: Session Implementation (2026-06-17)

## Summary

The recent session is directionally coherent: Marlin evidence, schema-level craft fields, deterministic compile behavior, and the new unified editorial agent all point toward a cleaner "Marlin eyes + Claude/Codex brain + deterministic compiler" architecture. TypeScript and the full Vitest suite pass, and most schema changes are additive/backward-compatible.

The main risk is that the repository has not fully converged on one canonical planning route. The old `/triage` and `/blueprint` flow, Gemini VLM/appraiser stages, craft-review fallback, and the new two-pass editorial scripts all coexist. That is workable during migration, but the routing now needs an explicit policy so future work does not accidentally run the wrong planner or skip state-machine guarantees.

Verification performed:

- `git log --oneline -35`: reviewed the recent 35 commits.
- `git diff HEAD~35 --stat`: reviewed the changed surface; 73 files changed, 15,299 insertions, 254 deletions.
- TODO/FIXME/HACK scan: only pre-existing TODOs found in `runtime/compiler/export.ts:162`, `runtime/artifacts/p4a-release-safety.ts:146`, and `runtime/artifacts/p4a-release-safety.ts:150`.
- `npx tsc --noEmit`: passed.
- `npx vitest run --reporter=verbose`: passed, 117 test files passed / 4 skipped, 2,194 tests passed / 39 skipped.

## Architecture

### 1. `--vlm-only` contradicts the simplified eyes/brain story

The pipeline computes Marlin eligibility with `!opts.vlmOnly`, so `--vlm-only` always suppresses Marlin (`runtime/pipeline/ingest.ts:146`). The same mode still runs the Gemini appraiser by default (`runtime/pipeline/ingest.ts:415`, `runtime/pipeline/ingest.ts:441`).

That is surprising under the new architecture. If Marlin is the primary scene reporter and Gemini appraisal is optional/degraded legacy evidence, `--vlm-only` should either be renamed/documented as "VLM/appraiser refresh" or split into explicit flags. As written, it keeps one Gemini-heavy path alive while suppressing the preferred Marlin evidence source.

### 2. `/analyze` command and direct `scripts/analyze.ts` have option drift

The direct script supports `skipAppraiser`, `vlmOnly`, and `sttStrategy` (`scripts/analyze.ts:36`, `scripts/analyze.ts:44`, `scripts/analyze.ts:47`, `scripts/analyze.ts:50`) and forwards them into `runPipeline` (`scripts/analyze.ts:282`, `scripts/analyze.ts:290`, `scripts/analyze.ts:291`, `scripts/analyze.ts:298`).

The command-layer API does not expose those options (`runtime/commands/analyze.ts:34`) and does not forward `skipAppraiser` or `vlmOnly` (`runtime/commands/analyze.ts:195`). That makes script behavior and command behavior diverge in exactly the area where migration flags matter.

### 3. The old blueprint route is still canonical for `/blueprint`

`/blueprint` still defaults into the narrative loop unless `iterativeEngine: false` is passed (`runtime/commands/blueprint/index.ts:283`, `runtime/commands/blueprint/index.ts:292`, `runtime/commands/blueprint/index.ts:305`). It then runs the craft reviewer by default (`runtime/commands/blueprint/index.ts:436`, `runtime/commands/blueprint/index.ts:438`, `runtime/commands/blueprint/index.ts:458`).

That is not inherently wrong, but it means the new two-pass unified editorial model is additive rather than canonical. `scripts/editorial-pipeline.ts` and `scripts/editorial-agent-task.ts` currently live beside the old triage/blueprint path instead of clearly replacing or wrapping it.

### 4. New editorial scripts bypass the artifact state machine

`scripts/editorial-pipeline.ts` validates and writes `04_plan/selects_candidates.yaml` and `04_plan/edit_blueprint.yaml` directly (`scripts/editorial-pipeline.ts:106`, `scripts/editorial-pipeline.ts:175`, `scripts/editorial-pipeline.ts:181`, `scripts/editorial-pipeline.ts:208`, `scripts/editorial-pipeline.ts:214`). `scripts/editorial-agent-task.ts` does the same for rough/fine agent responses (`scripts/editorial-agent-task.ts:143`, `scripts/editorial-agent-task.ts:283`, `scripts/editorial-agent-task.ts:289`, `scripts/editorial-agent-task.ts:352`, `scripts/editorial-agent-task.ts:358`).

These scripts do schema validation and atomic rename, which is good, but they bypass the normal promotion/state-transition path used by commands. That creates a coherence gap around `project_state.yaml`, concurrent edits, unresolved blockers, and auditability.

### 5. Marlin tool definitions are not yet integrated into an actual tool loop

`createEditorialToolkit` is implemented in `runtime/tools/editorial-tools.ts:130`, but current references are only tests and prompt/schema exposure. The unified agent includes tool definitions in interactive prompts (`runtime/agents/unified-editorial-agent.ts:830`), but there is no production agent execution loop that receives tool calls and invokes the toolkit.

The "Marlin as on-demand tool" commit is therefore partly architectural scaffolding. That is fine if intentional, but the docs/CLI should not imply tool-calling is already active in unattended runs.

## Bugs / Issues

### High: Render can ignore shortened adaptive trims

`applyAdaptiveTrim` mutates `clip.src_in_us` and `clip.src_out_us` when a trim is resolved (`runtime/compiler/trim.ts:553`, `runtime/compiler/trim.ts:555`, `runtime/compiler/trim.ts:556`). `buildRenderClips` then uses `clip.src_in_us` as the ffmpeg start time but derives duration solely from `timeline_duration_frames / fps` (`scripts/render-rough-cut.ts:386`, `scripts/render-rough-cut.ts:390`, `scripts/render-rough-cut.ts:391`).

If adaptive trim shortens the source range without also shortening `timeline_duration_frames`, the renderer can read past the intended `src_out_us`. The current render test asserts duration from timeline frames only (`tests/render-rough-cut.test.ts:137`, `tests/render-rough-cut.test.ts:163`, `tests/render-rough-cut.test.ts:169`), so this regression path is not covered.

Recommended fix: either keep `timeline_duration_frames` aligned when adaptive trim changes source range, or clamp render duration to `min(timeline_duration_frames / fps, (src_out_us - src_in_us) / 1_000_000)` with a regression test.

### Medium: Appraiser cannot be disabled through the command-layer analyze API

As noted above, `AnalyzeCommandOptions` lacks `skipAppraiser` (`runtime/commands/analyze.ts:34`) and `DefaultAnalyzeRunner` does not pass it to `runPipeline` (`runtime/commands/analyze.ts:195`). Since `runPipeline` runs the appraiser unless `opts.skipAppraiser` is set (`runtime/pipeline/ingest.ts:272`, `runtime/pipeline/ingest.ts:273`), the command wrapper cannot express the intended optional-appraiser policy.

### Medium: Headless unified editorial fallback swallows model failures

Both rough and fine passes catch all model/parse failures and silently fall back to deterministic normalization (`runtime/agents/unified-editorial-agent.ts:1224`, `runtime/agents/unified-editorial-agent.ts:1227`, `runtime/agents/unified-editorial-agent.ts:1228`, `runtime/agents/unified-editorial-agent.ts:1530`, `runtime/agents/unified-editorial-agent.ts:1531`, `runtime/agents/unified-editorial-agent.ts:1534`).

Resilient fallback is useful, but the caller loses whether a run used LLM output or deterministic fallback. That matters for reviewing edit quality and debugging prompt/model regressions. Return metadata or write a trace with the fallback reason.

### Medium: Default runtime assumptions differ inside the unified editor

The deterministic target duration helper falls back to 60 seconds (`runtime/agents/unified-editorial-agent.ts:295`, `runtime/agents/unified-editorial-agent.ts:299`), while the rough prompt defaults to 120 seconds, `fps = 24`, and `beatCount = 5` (`runtime/agents/unified-editorial-agent.ts:472`, `runtime/agents/unified-editorial-agent.ts:473`, `runtime/agents/unified-editorial-agent.ts:475`). The module-level compiler-ish constant is `FPS = 30` (`runtime/agents/unified-editorial-agent.ts:41`).

These values may be harmless in common projects with explicit brief runtime, but the defaults should not disagree. Keep them derived from one helper or make the prompt use the same duration/fps policy as normalization.

### Low: Craft review can silently accept when no Gemini key is present

`reviewBlueprintCraft` returns `verdict: "accept"` with a "skipped" summary when no injected LLM and no `GEMINI_API_KEY` exist (`runtime/agents/editorial-craft-agent.ts:659`, `runtime/agents/editorial-craft-agent.ts:661`, `runtime/agents/editorial-craft-agent.ts:664`). The default model path is still Gemini (`runtime/agents/editorial-craft-agent.ts:668`, `runtime/agents/editorial-craft-agent.ts:670`).

For local developer ergonomics this is understandable, but it should be visible in command output and traces because `/blueprint` otherwise appears to have completed a craft review that did not actually run.

## Schema Consistency

The schema changes are mostly additive and backward-compatible:

- `story_role`, `editorial_signals`, and `trim_hint` additions in selects are optional and consumed by scoring/compiler code.
- `active_editing_skills`, `trim_policy`, `duration_policy`, `timeline_order`, `track_layout`, and beat-level `craft` are optional blueprint fields. The compiler reads several of these fields and degrades when absent.
- `visual_appraisal`, `visual_quality`, and `peak_analysis` are optional segment fields, so existing `segments.json` artifacts remain valid.

No obvious "read but never written" or "written but impossible to read" schema break was found in the reviewed paths. The practical risk is not schema validity; it is routing: different entrypoints populate different subsets of the new optional fields, so downstream behavior can vary depending on whether a project used legacy triage/blueprint, craft review, or the unified editorial scripts.

## Test Gaps

1. Add a regression test for render duration clamping when `src_out_us - src_in_us` is shorter than `timeline_duration_frames / fps`. This covers the high-impact trim/render bug above.

2. Add option-parity tests for `runtime/commands/analyze.ts` versus `scripts/analyze.ts`, especially `skipAppraiser`, `vlmOnly`, and `sttStrategy`.

3. Add an integration test or golden fixture for `scripts/editorial-pipeline.ts` that asserts produced plan artifacts, compile output, and expected state/audit behavior. Today the script writes plan files directly and then compiles/renders.

4. Add an explicit test for `--vlm-only` behavior: whether it should run Gemini appraiser, Marlin, both, or neither. The current behavior is probably accidental-looking even if intentional.

5. Add a test or harness for actual Marlin tool-call execution if the on-demand tool story is meant to be production functionality. Current toolkit tests cover helper behavior, not an end-to-end agent/tool loop.

6. Add a trace/assertion around unified editorial headless fallback so tests can distinguish "model produced a plan" from "deterministic fallback normalized an empty/failed response."

## Dead Code / Tech Debt

### Gemini appraiser is not dead, but its role is ambiguous

The appraiser is still wired as a default stage after VLM (`runtime/pipeline/ingest.ts:272`) and in `--vlm-only` (`runtime/pipeline/ingest.ts:441`). It is therefore not removable today. The debt is naming and policy: decide whether it is an explicit optional high-res appraisal stage, a fallback-only old path, or still part of the canonical architecture.

### Multiple planning routes need ownership labels

The repository now has at least these planning routes:

- Legacy/selects path through `/triage` and `/blueprint`.
- LLM script path through `scripts/triage-llm.ts` and `scripts/blueprint-llm.ts`.
- Unified two-pass path through `scripts/editorial-pipeline.ts`.
- Interactive prompt/response path through `scripts/editorial-agent-task.ts`.

They can coexist, but one should be marked canonical for new projects and the others should be labeled fallback, diagnostic, or migration-only.

### `scripts/refine-clusters-once.ts` is a one-off artifact mutator

The script defaults to `projects/ena-promo-ai` (`scripts/refine-clusters-once.ts:7`) and rewrites `04_plan/selects_candidates.yaml` in place (`scripts/refine-clusters-once.ts:21`, `scripts/refine-clusters-once.ts:23`). It should be moved under a dev/diagnostics namespace, documented as a recovery script, or removed after the clustering migration is complete.

### On-demand Marlin tools are scaffolded but not wired

`runtime/tools/editorial-tools.ts` is useful scaffolding, but `rg` shows production references only through exported definitions and tests. Keep it if the next milestone is interactive tool-calling; otherwise document it as experimental to avoid confusing it with active pipeline behavior.

### Superseded design docs should be labeled

`docs/design-three-agent-vlm-architecture.md` and `docs/design-simplified-two-model-pipeline.md` represent different architecture snapshots. The same is true for the two editorial craft design docs. Keep the historical docs, but add a short supersession note so future contributors do not treat all of them as equally current.

## Recommendations

### P0

1. Fix render duration handling after adaptive trim and add a regression test.

2. Decide the canonical planning route for new projects. If the simplified two-model pipeline is canonical, make `/triage` and `/blueprint` either call into it, delegate clearly, or advertise themselves as legacy/fallback.

### P1

3. Align `runtime/commands/analyze.ts` with `scripts/analyze.ts` for `skipAppraiser`, `vlmOnly`, and `sttStrategy`, or document those as script-only diagnostic flags.

4. Put the new editorial scripts behind the same draft/promotion/state-transition guarantees as the command layer, or mark them as scratch-only and write outputs somewhere other than canonical `04_plan` paths by default.

5. Define appraiser policy explicitly: default-off optional appraisal, fallback-only legacy stage, or supported third model. Then rename flags/logs/docs to match.

6. Make unified editorial fallback observable in result metadata or trace files.

### P2

7. Add the integration tests listed above for `--vlm-only`, editorial-pipeline output/state behavior, and Marlin tool-call execution.

8. Move or retire `scripts/refine-clusters-once.ts` after confirming no active workflow depends on it.

9. Add supersession notes to older architecture/design docs so the current migration target is unambiguous.
