# Video editing pipeline refactoring audit

Date: 2026-07-22
Scope: current runtime, public CLI, interactive agent wrapper, canonical artifacts,
Agent Skills, and native Studio integration.

## Current executable flow

```text
source locators
  -> scripts/full-pipeline.ts
  -> runtime/pipeline/executor.ts
     -> analysis / source ledger / media links
     -> footage.db and retrieval indexes
     -> scripts/editorial-pipeline.ts
        -> rough selection + edit blueprint
        -> fine editorial refinement
        -> deterministic timeline compile
        -> rough render
        -> QA improvement loop + editorial_pipeline_status.json
  -> human review / approval
  -> caption and music decisions
  -> runtime/commands/package.ts + Gate 10
  -> final package / NLE handoff / publication preflight
```

The durable handoff between stages is the artifact chain rather than process
memory: `creative_brief.yaml` -> analysis artifacts and `footage.db` ->
`selects_candidates.yaml` -> `edit_blueprint.yaml` -> `timeline.json` -> review
artifacts -> package evidence and rendered outputs. `project_state.yaml` and its
reconciliation rules decide whether downstream artifacts are still current.

There are two additional operator paths:

- `scripts/editorial-agent-task.ts` prepares or consumes interactive rough/fine
  responses, then rejoins the same compile/render functions.
- VideoOSStudio reads the same canonical artifacts and invokes repository
  scripts; it does not own a second timeline or pipeline.

## Agent Skill integration

Agent Skills in `.agents/skills/` are operating runbooks, not compiler plugins.
They select an executable entrypoint and verify the artifact/gate contract:

| Workflow intent | Agent Skill | Executable authority | Main artifact boundary |
| --- | --- | --- | --- |
| End-to-end rough cut | `full-pipeline` | `scripts/full-pipeline.ts` -> `runtime/pipeline/executor.ts` | source -> QA-backed rough cut |
| Analyze footage | `analyze-footage` | `runtime/commands/analyze.ts` / analysis pipeline | `03_analysis/*`, source map |
| Select and structure | `select-clips`, `build-blueprint` | canonical editorial pipeline or command recovery route | `04_plan/*` |
| Compile | `compile-timeline` | deterministic compiler | `05_timeline/timeline.json` |
| Review and re-edit | `review-roughcut`, `re-edit` | review command + schema-safe patch compile | `06_review/*` -> new timeline version |
| Render/package | `render-video` | render route + package command + Gate 10 | `07_package/*`, `09_output/*` |
| NLE roundtrip | `export-premiere`, `import-premiere` | handoff adapters | FCP7 XML/editor packet <-> timeline |

Editorial skills in `runtime/editorial/skills/*.yaml` are a different layer:
they contribute bounded compiler effects after profile/policy resolution. They
must not be conflated with Agent Skills or become a hidden artifact authority.

## Prioritized refactoring candidates

### Completed in this slice

1. **P0 — align headless and interactive planning preflight.** The interactive
   wrapper duplicated planning context loading, required `marlin_events.json`
   even though Marlin is optional, and did not call the canonical media-kind and
   still-grounding guards. Both entrypoints now use
   `runtime/pipeline/editorial-context.ts`.
2. **P1 — remove compile/render adapter duplication.** Both editorial
   entrypoints carried the same direct compile/render options. They now use
   `scripts/editorial-stages.ts`, preserving in-process execution and one option
   contract.
3. **P1 — centralize planning artifact writes.** The duplicated validation plus
   temporary-file rename logic for plan/status artifacts now has one shared
   implementation.
4. **P0 — converge full-pipeline phase execution.** The public script executor
   and command/state-machine pipeline now use
   `runtime/pipeline/phase-executor.ts` for ordered execution, stop-on-failure,
   and completed-phase accounting. Their distinct dependency injection, resume,
   review-patch, package, and error-reporting policies remain local.
5. **P1 — normalize stage vocabulary.** Canonical artifact stages now have an
   explicit mapping to legacy progress/timing values. The public `--from`
   vocabulary has its own type, order, and validator, and CLI help is generated
   from that contract. Existing values such as `visual-quality`, `embeddings`,
   and `QA` remain compatible.
6. **P1 — make Agent Skill drift machine-checkable.** The top-level
   `full-pipeline` Skill now has a generated manifest for its primary/recovery
   commands, public flags, resume values, prerequisite references, and produced
   artifacts. The public CLI help consumes the same executable contract, and
   tests fail if the manifest, entrypoints, package scripts, or Skill contract
   lines drift. Additional stage Skills can join this seam incrementally.
7. **P1 — make interactive completion semantics explicit.** Headless and
   interactive planning now rejoin `scripts/editorial-downstream.ts` for
   compile, render, QA, and status writing. Interactive prompt emission reports
   a pending response and does not claim QA completion; once responses are
   applied, QA runs by default. Explicit `--skip-qa` writes a blocking status,
   and the status artifact records the actual entrypoint.
8. **P2 — isolate the Marlin ingest transaction boundary.**
   `runtime/pipeline/ingest-marlin.ts` now owns staged Marlin artifact
   publication, rollback and legacy scrubbing, readiness, and gap reporting.
   `ingest.ts` retains only the source-hash adapter and both normal/all-cached
   call sites. The narrow `MarlinStageOptions` contract avoids an import cycle,
   while readiness types remain backward-compatible re-exports from
   `ingest.ts`.
9. **P2 — isolate VLM-only source restoration.**
   `runtime/pipeline/source-file-map.ts` now owns the persisted source-map,
   asset locator, image-sequence proxy, basename, and project-layout fallback
   order. Direct contract tests pin all eight candidate levels and the existing
   warn-but-preserve-first-candidate behavior when no source exists.
10. **P2 — isolate existing analysis artifact restoration.**
    `runtime/pipeline/analysis-artifact-restoration.ts` now owns reusable
    derivative discovery, VLM-only segment field merging, segment grouping, and
    cache-manifest rebuilding. Direct tests cover complete and degraded
    derivative sets, VLM-owned versus preserved fields, live source identity
    refresh, prior-entry retention, and unknown missing sources. The same
    derivative loader remains shared by VLM-only and cached-peak revalidation.
11. **P2 — isolate source-readiness publication.**
    `runtime/pipeline/source-readiness.ts` now owns the ordered source ledger,
    source manifest, and initial coverage publication plus the hard-gate empty
    analysis artifacts. `SourceReadinessError` remains a backward-compatible
    export from `ingest.ts`. Direct tests distinguish successful continuation
    from hard-gated replacement and pin the structured error contract; the
    existing source-ledger, still-image, image-sequence, and Marlin tests cover
    both call sites end to end.
12. **P2 — isolate audio-analysis artifact finalization.**
    `runtime/pipeline/audio-analysis-artifacts.ts` now owns audio-event
    publication, explicit BGM identity resolution, VLM/peak coverage summaries,
    current transcript enumeration, coverage publication, and audio story graph
    status parity for both normal and all-cached ingest. Its narrower options
    contract replaces the full `PipelineOptions` dependency. Direct tests pin
    the graph status table, stale/empty transcript exclusion, corrupt transcript
    failure, canonical BGM aliasing, and missing/mismatched graph failures.
13. **P2 — isolate source-derived artifact cleanup.**
    `runtime/pipeline/analysis-artifact-cleanup.ts` now owns stale still-frame
    and image-sequence proxy removal after the current successful source set is
    known. Direct tests verify absent roots, mixed current/stale directories,
    empty success sets, and preservation of plain files, symlinks, and their
    external targets. Existing still/image-sequence integration tests keep the
    readiness-failure and source-set-change behavior covered end to end.
14. **P2 — converge cross-language Studio artifact contracts.**
    `scripts/package.ts --preflight-only --json` now exposes the actual
    TypeScript Gate 10 preflight as a read-only oracle. Studio evaluates it off
    the main actor on project refresh and immediately before render, and fails
    closed when the process, JSON response, project path, exit status, or
    required identity fields are inconsistent. The Swift package reader now
    requires the schema-required QA/manifest projection and checks canonical
    project ID, QA profile, and source-of-truth agreement before reporting
    `render packaged`; runner success uses that validated result. A generated,
    byte-stable SwiftPM resource exercises the same TypeScript playback states,
    Gate 10 blockers (including stale caption approval), and package schema/
    identity failures in both Vitest and Swift tests.

### Remaining candidates in the audited scope

None. Swift continues to decode bounded views of larger canonical artifacts by
design; those views are consumers rather than a second artifact authority. New
consumed fields or semantic branches must be added through the generated
cross-language fixture instead of another hand-maintained rule mirror.

## Refactoring constraints

- Canonical artifacts and reconciliation remain authoritative.
- Optional model paths remain fail-open; unsupported media capabilities remain
  visible and fail closed at the correct planning/render/package boundary.
- Compiler and render functions remain directly callable without subprocesses.
- Existing public CLI flags and artifact locations remain backward-compatible;
  the interactive wrapper adds `--skip-qa` to make an incomplete completion
  state explicit.
