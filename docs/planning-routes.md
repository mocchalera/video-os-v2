# Planning Routes

This repo has multiple ways to produce planning artifacts. Use this routing unless a project-specific runbook says otherwise.

## Canonical

For new projects, use the unified two-pass editorial pipeline. The rough pass normalizes candidates, assigns capture-time semantic clusters when source metadata is available, then applies the shared quality gate before writing `selects_candidates.yaml`:

```sh
npx tsx scripts/editorial-pipeline.ts --project <projectDir>
```

For Cockpit or repo-side interactive work, use the agent wrapper:

```sh
npx tsx scripts/editorial-agent-task.ts --project <projectDir>
```

`scripts/editorial-agent-task.ts` wraps the same rough/fine planning model used by
`scripts/editorial-pipeline.ts`; it exists for headless or interactive agent
handoff. In interactive mode, writing a rough/fine prompt is an explicit pending
state: QA and `06_review/editorial_pipeline_status.json` are not updated until
the required response is supplied. After the response is applied, interactive
mode rejoins the same compile/render/QA/status runner as headless mode. QA runs
by default; `--skip-qa` records a blocking `QA_SKIPPED` status rather than
silently treating compile/render as completion.

`editorial.profile_hint: longform-event` is a canonical specialized branch inside `scripts/editorial-pipeline.ts` and therefore also inside `npm run full-pipeline`. It replaces the rough/fine LLM pass with deterministic transcript reduction and chapter allocation, then rejoins the shared compile/render/QA stages. See `docs/longform-event-mode.md`.

## Legacy Fallback

Use `/triage` plus `/blueprint` only when the canonical route is not available, such as projects without Marlin artifacts or headless CI flows that must exercise the older command path. The command route uses the same clustering and quality-gate implementation, and also supports `longform-event`, but it is no longer the preferred planning path.

## Diagnostic

Do not use the legacy standalone LLM wrappers for new diagnostics. Prefer the canonical pipeline or `scripts/editorial-agent-task.ts`; the old wrappers remain only while direct test/doc references are retired.

## One-Off Utilities

`scripts/refine-clusters-once.ts` is a migration utility for one-off cluster refinement. Do not use it as part of regular planning runs.
