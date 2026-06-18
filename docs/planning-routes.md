# Planning Routes

This repo has multiple ways to produce planning artifacts. Use this routing unless a project-specific runbook says otherwise.

## Canonical

For new projects, use the unified two-pass editorial pipeline:

```sh
npx tsx scripts/editorial-pipeline.ts --project <projectDir>
```

For Cockpit or repo-side interactive work, use the agent wrapper:

```sh
npx tsx scripts/editorial-agent-task.ts --project <projectDir>
```

`scripts/editorial-agent-task.ts` wraps the same rough/fine planning model used by `scripts/editorial-pipeline.ts`; it exists for headless or interactive agent handoff.

## Legacy Fallback

Use `/triage` plus `/blueprint` only when the canonical route is not available, such as projects without Marlin artifacts or headless CI flows that must exercise the older command path.

## Diagnostic

Use `scripts/triage-llm.ts` and `scripts/blueprint-llm.ts` for standalone testing of individual LLM-backed planning stages. They are diagnostic entry points, not the default route for new projects.

## One-Off Utilities

`scripts/refine-clusters-once.ts` is a migration utility for one-off cluster refinement. Do not use it as part of regular planning runs.
