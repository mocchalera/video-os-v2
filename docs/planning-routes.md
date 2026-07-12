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

`scripts/editorial-agent-task.ts` wraps the same rough/fine planning model used by `scripts/editorial-pipeline.ts`; it exists for headless or interactive agent handoff.

## Legacy Fallback

Use `/triage` plus `/blueprint` only when the canonical route is not available, such as projects without Marlin artifacts or headless CI flows that must exercise the older command path. The command route uses the same clustering and quality-gate implementation, but it is no longer the preferred planning path.

## Diagnostic

Do not use the legacy standalone LLM wrappers for new diagnostics. Prefer the canonical pipeline or `scripts/editorial-agent-task.ts`; the old wrappers remain only while direct test/doc references are retired.

## One-Off Utilities

`scripts/refine-clusters-once.ts` is a migration utility for one-off cluster refinement. Do not use it as part of regular planning runs.
