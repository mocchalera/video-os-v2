# Current Decisions

Status: current decisions as of 2026-07-11. Earlier design/review documents are
historical evidence unless a current executable path or this register retains
their decision.

## D-001 Artifact authority

Canonical YAML, JSON, SQLite, and media reports are the source of truth. Chat,
logs, dashboards, Studio view state, OTIO, and FCP7 XML are projections or
handoffs. The controlling paths are `runtime/state/reconcile.ts`, `schemas/`,
and the artifact readers/writers under `runtime/commands/`.

## D-002 Speech-led first product route

The first product proof is `interview-highlight` with `interview` policy and an
actual 60-180 second output. It reuses `creative_brief.yaml`, analysis artifacts,
planning artifacts, `timeline.json`, review/package artifacts, and
`project_state.yaml`. `docs/speech-led-highlight-product-contract.md` is the
normative route contract; alternative new artifact types are not current.

## D-003 Runtime owns orchestration

`runtime/pipeline/plan.ts` and `runtime/pipeline/executor.ts` own the canonical
pipeline plan and execution. `scripts/full-pipeline.ts` is the public CLI
adapter. Scripts may adapt arguments and process exit codes, but orchestration
logic should move into runtime rather than grow a second implementation.

## D-004 State is reconstructable and may move backward

`project_state.yaml` is durable workflow state, but it is reconciled against
artifact existence, schema/analysis readiness, hashes, approval bindings, and
package QA. Upstream changes invalidate downstream authority and may self-heal
the project to an earlier state. Backtracking is a safety property, not an
error. Exact semantics are in [PIPELINE_STATES.md](PIPELINE_STATES.md).

## D-005 Preview availability does not grant final authority

A rough/exact preview can remain available after a QA failure or skipped QA.
The same condition blocks final render/package in
`editorial-pipeline-status.json`. Final packaging separately passes Gate 10,
package QA, manifest/freshness, and publication checks.

## D-006 Studio is the operator cockpit

`apps/macos-studio` is the canonical product UI. It coordinates project
inspection, direct edits, Agent jobs, preview, compile, render, and package
through canonical artifacts and repository runners. `StudioViewModel` remains
the compatibility facade while the active decomposition plan extracts stores
and cohesive view layers without changing artifact contracts.

## D-007 Preview-server ownership

`editor/server` and `editor/shared` are supported local infrastructure.
`editor/server` is independently started and is not a dependency of macOS
Studio. `editor/client` is retired. This decision is backed by T-0007 evidence,
`editor/tsconfig.json`, `editor/package.json`, `Package.swift`, and required CI.

## D-008 Timeline and patch ownership

`timeline.json` is the canonical timeline IR. Agent suggestions are expressed
as review/studio patch operations and inspected before persistence. The
compiler/runtime applies deterministic operations; arbitrary Agent-generated
FFmpeg commands and hidden direct mutations are not accepted. NLE exports and
imports preserve stable IDs and report lossy or unmapped edits.

## D-009 Local-first capability boundaries

Local models and cloud connectors enrich perception, transcription, retrieval,
or editorial reasoning but do not become the source of truth. Qwen3-VL, CLAP,
Marlin, and optional STT/VLM integrations remain fail-open for ordinary local
operation when caches or dependencies are absent. The dedicated real-media
release regression is fail-closed by design.

## D-010 Profile, policy, editorial skill, and agent skill are distinct

Profiles choose defaults and active editorial skills; policies express
editorial rules; editorial skills contribute bounded deterministic compiler
effects; `.agents/skills/` govern agent workflows. An agent skill may operate a
profile or artifact, but cannot silently redefine runtime profile/policy/skill
semantics.

## D-011 Local media is a capability, not public data

The preview server authorizes source-map paths using project roots,
realpath-based containment, explicit environment roots, or an exact symlink
inside `02_media`; source-map API responses redact local path fields. The
server is trusted-local tooling, not an authenticated internet service. See
[SECURITY_MODEL.md](SECURITY_MODEL.md).

## D-012 Release evidence is multi-layered

Release readiness is not inferred from a single test command. It requires the
responsibility jobs in `.github/workflows/ci.yml`, relevant schema and package
checks, repository hygiene, human approval/waivers where required, a declared
source of truth, and evidence tied to the exact revision and artifacts. The
self-hosted speech-led real-media workflow supplies live-model evidence without
uploading the source render.

## D-013 Release-safety preflight is not yet an enforcing release gate

`runtime/artifacts/p4a-release-safety.ts` currently implements `dry_run` when
`ENABLE_P4A_RELEASE_SAFETY` is enabled. `report_only` and `enforce` explicitly
throw `not_implemented_in_p4a`. Do not describe the release-safety report as an
enforced production gate until executable behavior changes.
