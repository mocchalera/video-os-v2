# Short-form retention feedback implementation evidence

Date: 2026-07-17

Feature: `F-0066` / Story: `US-0038`

## Feedback translated into typed behavior

- Strong result is previewed in a distinct 1-2 second cold open only when the brief explicitly describes short social delivery and aggressive/cold-open intent.
- The complete payoff starts by approximately 65% of runtime when the premise is already legible.
- Structural beat vocabulary remains internal. `beat.viewer_label` carries audience-facing story copy for HyperFrames/Remotion section labels.
- Low-motion/talking-head short social plans a semantic visual refresh every 6-12 seconds using real reactions/cutaways or registered reframe/emphasis devices, without arbitrary zoom/flash effects.
- `credibility_first` and high-credibility briefs do not receive a forced fragmentary spoiler.
- Non-social or longer-than-90-second briefs receive no retention prompt or audit.

## Current beatbox artifact read-only audit

Input artifacts:

- `projects/img-3921-content/01_intent/creative_brief.yaml`
- `projects/img-3921-content/04_plan/selects_candidates.yaml`
- `projects/img-3921-content/04_plan/edit_blueprint.yaml`

Before defaults:

- `payoff_too_late`: complete payoff began at 67% of runtime.
- `system_label_exposed`: hook/escalation/turn/payoff/resolution had no audience-facing labels.
- `visual_refresh_plan_missing`: the low-motion source had no explicit semantic visual-refresh plan.

After applying the shared defaults in memory only:

- complete payoff start: frame 1190 / 1831 (65% boundary)
- opening duration: 48 frames (2 seconds at 24fps)
- first `viewer_label`: `先に結果をどうぞ`
- remaining audit issues: 0

The approved project artifact and rendered video were not rewritten by this verification.

## Verification

Node/npm:

- Node `v22.23.1`
- npm `10.9.8`

Commands and results:

- `npm run build`: pass
- targeted Vitest: 6 files / 104 tests passed
- `npm test`: pass (184 files passed, 6 skipped; 2892 tests passed, 41 skipped)
- `npm run verify`: all gates passed
- `npm run eval -- --suite golden --no-write`: pass
- Fixed golden values remained unchanged: fumoto-growth 52, togakushi-camp 100, ena-promo 100, ax1-komatsu-testimonial-d4892 100, ax1-female-testimonial-d4892 100.
- `git diff --check`: pass

Broader `--all --no-write` discovery reported a pre-existing invalid negative `src_in_us` in `rokutaro-bicycle-growth-20260427`; the fixed regression suite and all tests remain green, and this unrelated golden artifact was not modified.

## Main surfaces

- `runtime/editorial/short-form-retention.ts`
- `runtime/agents/llm-triage-agent.ts`
- `runtime/agents/llm-blueprint-agent.ts`
- `runtime/agents/unified-editorial-agent.ts`
- `schemas/edit-blueprint.schema.json`
- `runtime/compiler/normalize.ts`
- `runtime/compiler/assemble.ts`
- `.agents/skills/build-blueprint/SKILL.md`
- `.agents/skills/full-pipeline/SKILL.md`
- `docs/short-form-retention-planning.md`
- `tests/short-form-retention.test.ts`
