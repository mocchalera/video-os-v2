# T-0008 Current Architecture and Operating Docs Evidence

Date: 2026-07-11 JST
Task: `T-0008` — Publish current architecture and operating docs
Branch baseline: `Dev` at `aeb9735c`, two local commits ahead of `origin/Dev`

## Outcome

Published the six requested current-truth documents:

- `docs/CURRENT_ARCHITECTURE.md`
- `docs/DECISIONS.md`
- `docs/DEPRECATED.md`
- `docs/PIPELINE_STATES.md`
- `docs/SECURITY_MODEL.md`
- `docs/RELEASE_CHECKLIST.md`

Added only the minimum current-truth navigation to `README.md` and
`ARCHITECTURE.md`. No runtime, dependency, schema, CI, or workflow behavior was
changed.

## Current-truth coverage

The documents are grounded in the current executable and recorded boundaries:

- `runtime/pipeline/plan.ts`, `runtime/pipeline/executor.ts`, and
  `scripts/full-pipeline.ts` for runtime-owned orchestration and thin CLI
  adaptation;
- canonical project artifacts and `schemas/` for persisted authority;
- `runtime/state/reconcile.ts`, `runtime/state/history.ts`,
  `schemas/project-state.schema.json`, and
  `schemas/editorial-pipeline-status.schema.json` for forward transitions,
  invalidation/backtracking, and preview-versus-final separation;
- `runtime/packaging/gate10.ts`, `runtime/commands/package.ts`, and package
  schemas for approval, handoff, QA, manifest, and final authority;
- `apps/macos-studio`, `Package.swift`, T-0007 evidence, `editor/server`,
  `editor/shared`, `editor/client`, and `.github/workflows/ci.yml` for product,
  preview-server, retired-client, and required-CI ownership;
- `editor/server/utils.ts`, media routes, source-map paths, repo hygiene, and
  security tests for local-media roots, realpath/symlink handling, API path
  redaction, resource limits, and publication boundaries;
- `runtime/editorial/profiles/`, policies, the policy resolver, editorial skill
  registry, and `.agents/skills/` for profile/policy/editorial-skill/agent-skill
  separation;
- `docs/speech-led-highlight-product-contract.md` and the speech-led CI
  workflows for the 60-180 second interview-highlight golden path and release
  evidence.

The security document explicitly records that the unauthenticated preview
server is trusted-local infrastructure and is not explicitly loopback-bound.
The decisions/release documents explicitly record that P4a release-safety
supports feature-flagged `dry_run`; `report_only` and `enforce` remain
unimplemented.

## Verification

| Command | Result |
| --- | --- |
| `git diff --check` | Passed |
| Local Markdown link scan over README, ARCHITECTURE, and six current-truth docs | Passed: 8 files, no broken local targets |
| `npm run verify` under explicit Node `v22.23.1` / npm `10.9.8` | Passed: typecheck; 157 test files passed, 4 skipped; 2,621 tests passed, 39 skipped; demo schema validation checked 15 artifacts with 0 errors / 0 warnings; review-metrics command completed |
| `npm run test:schema-contract` | Passed: 3 files / 88 tests |
| `npm run test:speech-led-contract` | Passed: 3 files / 17 tests |
| `npm run verify:repo` | Passed: 1,393 tracked files |
| `npm --prefix editor run typecheck` | Passed |
| `npx vitest run tests/editor-server-media-roots.test.ts editor/tests/parity` | Passed: 6 files / 36 tests; 2 files / 36 FFmpeg parity tests skipped because `PARITY=1` was not set |
| `swift test` | Passed: 520 tests, 0 failures |
| `swift run videoos-studio-cli doctor` | Passed: repository resolved and 29 local projects reported |
| `npm run verify:agents` | Passed: 9 Claude/Codex role definitions generated with no tracked or untracked drift |
| `pcl validate --strict --json` before work | Passed with no errors and pre-existing lifecycle/evidence advisories |

The first aggregate verification attempt ran through the shell's shimmed Node
`v24.8.0` and failed 40 SQLite-dependent tests because `better-sqlite3` was
built for Node module ABI 127 while Node 24 required ABI 137. The repository
requires Node 22. Re-running with the explicit Node 22 binary passed all
aggregate gates. No dependency installation or rebuild was performed.

`npm run verify` rewrote the checked-in demo `review_metrics.json` as a command
side effect. That exact generated diff was removed; the file matches `HEAD` and
is not part of T-0008.

## Contradiction and staleness checks

- Current product ownership consistently names macOS Studio as operator
  cockpit, server/shared as supported infrastructure, and client as retired.
- Preview availability is never described as approval or package authority.
- State names and gate enums match the current schemas.
- Public commands match current `package.json` scripts or existing TypeScript /
  Swift entrypoints.
- Local Markdown targets in all eight touched docs exist.
- Historical document precedence is explicit and does not delete history.

## Residual risks

- `npm run verify -- --full` was not run. This docs-only task ran the fast
  aggregate gate and focused boundaries; 36 FFmpeg render-parity tests remained
  skipped without `PARITY=1`, and no golden agreement evaluation was repeated.
- GitHub Actions and the self-hosted speech-led real-media workflow were not
  executed in this local docs-only pass. Current workflow definitions and prior
  recorded evidence are documented, not re-certified as a fresh remote run.
- The preview server remains unauthenticated and not explicitly
  loopback-bound. The documentation now makes that limitation and the required
  trusted-local deployment boundary explicit; no runtime hardening was in
  T-0008 scope.
- P4a release-safety `report_only` and `enforce` modes remain unimplemented.
  The docs avoid claiming enforcement.

## Repository hygiene

- The pre-existing commits `aeb9735c` and `d5c5f181` remain untouched.
- No commit or push was performed.
- Final changed files are limited to the six requested docs, two navigation
  files, this evidence report, and ignored Project Loop state generated through
  `pcl`.
- Generated Project Loop lock files are removed after the final validate/render
  sequence.
