# Current Architecture

Status: current truth as of 2026-07-11. This document describes executable
ownership. Historical design and review documents remain useful context but do
not override the paths, schemas, and CI boundaries cited here.

## Product shape

RoughCut Agent is a local-first, artifact-driven editing system. The supported
speech-led golden path is an `interview-highlight` / `interview` project that
produces an actual 60-180 second rough cut through the existing state machine;
it does not introduce a second artifact model. The normative product contract
is [speech-led-highlight-product-contract.md](speech-led-highlight-product-contract.md).

The current operator cockpit is the native macOS application in
`apps/macos-studio`. `VideoOSStudioApp.swift` is the GUI entrypoint and
`videoos-studio-cli` is its diagnostic/automation companion. Studio reads
canonical project artifacts and uses Swift runners to invoke repository
scripts. It does not own a parallel pipeline or start the preview server.

`editor/server` is supported, independently started local preview/API
infrastructure. It owns exact-preview jobs, media delivery, timeline/review
routes, and WebSocket notifications. `editor/shared` owns render/parity
contracts used by preview and final-render paths. `editor/client` is retired;
see [DEPRECATED.md](DEPRECATED.md).

## Runtime and CLI ownership

`runtime/pipeline/plan.ts` is the canonical stage vocabulary and planning
surface. It also owns the explicit mapping from canonical artifact stages to
legacy progress/timing stages and the separately typed public `--from` resume
vocabulary. Progress history and CLI compatibility therefore retain values such
as `visual-quality`, `embeddings`, and `QA` without making those values canonical
artifact-stage names. `runtime/pipeline/executor.ts` owns project initialization,
analysis, footage-DB execution, editorial-pipeline delegation, progress, and
failure reporting. `scripts/full-pipeline.ts` is a thin CLI adapter over that runtime.
`runtime/pipeline/phase-executor.ts` owns ordered phase execution, stop-on-failure,
and completed-phase accounting shared by the public script executor and the
command/state-machine full-pipeline. Each orchestrator retains its own resume,
review, package, dependency-injection, and failure-reporting policy.
`runtime/pipeline/editorial-context.ts` owns the guarded planning context shared
by `scripts/editorial-pipeline.ts` and `scripts/editorial-agent-task.ts`, so
headless and interactive planning apply the same media-kind/still-grounding
preflight and optional-Marlin fallback. After planning completes,
`scripts/editorial-downstream.ts` is their shared compile/render/QA/status
runner; interactive prompt emission remains an explicit pending state until the
required response is supplied. `scripts/editorial-stages.ts` provides the
in-process compile/render adapters, so neither orchestrator shells out to a
second CLI process. Status artifacts identify whether completion came from
`editorial-pipeline` or `editorial-agent-task`.
The supported default is:

```sh
npm run full-pipeline -- --project <project-id> --source-dir /path/to/footage
```

The canonical stage vocabulary is `ingest`, `analyze`, `stt`, `marlin`,
`visualQuality`, `peak`, `embeddings`, `footageDb`, `triage`, `blueprint`,
`compile`, `review`, `render`, `qa`, and `package`. Individual scripts remain
supported debugging and recovery entrypoints, but must not become competing
orchestrators.

Optional model connectors under `runtime/connectors/` are capabilities, not
artifact authorities. Qwen3-VL, CLAP, Marlin, STT providers, and other optional
local/cloud paths may enrich analysis and retrieval. Missing model caches,
workers, or optional dependencies must leave deterministic compile, schema
validation, FTS/E5 fallbacks, and already-produced artifacts usable.

## Artifact authority

Project truth is persisted in files, not chat or Studio view state. The main
authoritative chain is:

```text
01_intent/creative_brief.yaml
01_intent/unresolved_blockers.yaml
03_analysis/* and 03_analysis/search/footage.db
04_plan/selects_candidates.yaml
04_plan/edit_blueprint.yaml
04_plan/uncertainty_register.yaml
05_timeline/timeline.json
06_review/review_report.yaml, review_patch.json, human_notes.yaml
project_state.yaml
07_package/caption_approval.json, music_cues.json, qa-report.json,
  package_manifest.json
09_output/render-report.json and published media
```

The JSON Schemas in `schemas/` define structured contracts. `timeline.json`
remains the canonical timeline IR; OTIO and FCP7 XML are handoff formats.
`project_state.yaml` records the current state, gates, artifact hashes,
approval, analysis override, handoff decision, resume data, and transition
history. See [PIPELINE_STATES.md](PIPELINE_STATES.md).

Agents and Studio may prepare inspectable patch operations. Deterministic
compiler/runtime paths apply those operations and persist canonical artifacts.
In-memory Studio edits are previews until explicitly saved; read-only Agent
consultation output does not mutate `timeline.json`.

## Planning profiles, policies, and skills

These layers have distinct ownership:

- A profile in `runtime/editorial/profiles/*.yaml` supplies product defaults
  such as target duration, cadence, trim policy, and active editing skills.
- A policy in `runtime/editorial/policies/*.yaml` supplies editorial selection
  and structure rules.
- `runtime/editorial/policy-resolver.ts` resolves explicit brief hints first,
  then deterministic inference, then the `interview-highlight` default.
- A skill in `runtime/editorial/skills/*.yaml` contributes bounded compiler
  effects. `runtime/editorial/skill-registry.ts` validates signal and phase
  requirements before those effects are used.
- Agent workflow skills in `.agents/skills/` govern how an agent operates the
  repository. They are not editorial compiler skills and do not replace
  canonical artifacts. The top-level orchestration contract lives in
  `runtime/pipeline/full-pipeline-contract.ts`; it generates
  `.agents/skills/agent-skill-contracts.json` and the public CLI help. Contract
  tests bind the `full-pipeline` Skill to executable commands, flags, resume
  values, prerequisite references, and produced-artifact boundaries.

`runtime/editorial/matrix.yaml` is a compatibility inventory, but executable
profile defaults and the resolver are the current runtime authority. A matrix
entry marked deferred must not be assumed unavailable if the runtime registry
and tests have since implemented it; validate against executable loading.

## Render, preview, and package planes

Rough preview and final delivery are intentionally separate:

- `scripts/render-rough-cut.ts` and the editor preview stack produce reviewable
  media and duration/parity evidence.
- `schemas/editorial-pipeline-status.schema.json` permits preview to remain
  `available` when QA fails or is skipped, while requiring final render and
  package to be `blocked` with a reason.
- `runtime/packaging/gate10.ts` and `runtime/commands/package.ts` own the final
  package gate. Packaging requires an approved or already-packaged project,
  current approval bindings, a decided `engine_render` or `nle_finishing`
  source of truth, open review gate, acceptable fatal/visual-QA status, and
  non-stale caption/music inputs when present.
- Package authority requires passed `07_package/qa-report.json` plus a matching
  `package_manifest.json`; file existence alone cannot restore `packaged`.

## CI ownership

`.github/workflows/ci.yml` protects nine responsibility jobs plus the aggregate
`product-gate`:

| Job | Current boundary |
| --- | --- |
| `node-runtime` | Node 22 install, demo schema validation, TypeScript build, root tests, FFmpeg-backed integration |
| `schema-contract` | focused schema/analysis/editorial-status contracts |
| `speech-led-contract` | first-run speech-led artifact contract |
| `event-recap-contract` | second-profile shared-pipeline delta contract |
| `repo-hygiene` | tracked env, generated output, rendered media, and large-file boundaries |
| `editor-server` | supported `editor/server` and `editor/shared` typecheck |
| `agent-definitions` | generated Claude/Codex agent drift |
| `macos-studio` | SwiftPM tests and Studio CLI doctor on macOS 14 |
| `render-integration` | real FFmpeg render integration with pinned runtime provenance |

The scheduled/manual `.github/workflows/speech-led-real-media.yml` is a separate
self-hosted, rights-cleared, fail-closed live-Marlin regression. Local optional
model behavior remains fail-open; the release regression is deliberately
stricter.

## Further current-truth documents

- [DECISIONS.md](DECISIONS.md)
- [PIPELINE_STATES.md](PIPELINE_STATES.md)
- [SECURITY_MODEL.md](SECURITY_MODEL.md)
- [RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md)
- [DEPRECATED.md](DEPRECATED.md)
