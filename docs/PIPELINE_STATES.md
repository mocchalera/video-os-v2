# Pipeline States and Gates

Status: current executable state semantics as of 2026-07-11. Authority:
`runtime/state/reconcile.ts`, `runtime/state/history.ts`, command preconditions,
`runtime/packaging/gate10.ts`, and `schemas/project-state.schema.json`.

## Durable states

| State | Stable evidence |
| --- | --- |
| `intent_pending` | brief or unresolved-blocker document is not yet complete |
| `intent_locked` | `creative_brief.yaml` and `unresolved_blockers.yaml` exist, but analysis is not ready |
| `media_analyzed` | analysis gate is ready or explicitly partial-overridden; selects do not yet exist |
| `selects_ready` | `selects_candidates.yaml` exists; blueprint does not |
| `blueprint_ready` | `edit_blueprint.yaml` exists; timeline does not; compile/planning gates are open |
| `blocked` | blueprint exists and compile or planning gate is blocked |
| `timeline_drafted` | `timeline.json` exists; review artifacts do not |
| `critique_ready` | review artifacts exist and approval is absent, pending, stale, or mismatched |
| `approved` | approval is `clean` or `creative_override` and recorded artifact versions match current artifacts |
| `packaged` | approved authority plus passed package QA and a current package manifest |

`blocked` is a gate projection, not a permanent terminal state. Resolving or
waiving the controlling blocker allows reconciliation back to the highest
stable artifact-backed state.

## Gate fields

`project_state.yaml.gates` carries separate controls:

- `analysis_gate`: `ready`, `partial_override`, or `blocked` from validated
  analysis coverage and a current analysis override.
- `compile_gate`: blocked by a `status: blocker` entry in
  `unresolved_blockers.yaml`.
- `planning_gate`: open, partial override, or blocked from planning uncertainty
  and analysis conditions.
- `timeline_gate`: protects timeline production/consumption.
- `review_gate`: protects approval and Gate 10.
- `packaging_gate`: protects package freshness and final authority.

A gate being open does not manufacture missing artifacts or human decisions.

## Forward command flow

The supported speech-led route uses the ordinary pipeline:

```text
intent
  -> analysis and footage.db
  -> triage/selects
  -> blueprint/uncertainty
  -> deterministic compile/timeline
  -> review and inspectable patch
  -> human approval or explicit creative override
  -> caption/music decisions as applicable
  -> Gate 10 source-of-truth decision
  -> render/package QA and manifest
  -> packaged
```

Commands call state initialization/reconciliation before checking their allowed
start states. Successful commands write artifacts and append history through
`transitionState`; direct manual edits of `project_state.yaml` can be
overwritten or invalidated on the next reconcile.

## Backtracking and stale authority

Reconcile snapshots artifact hashes and applies the invalidation matrix:

| Changed authority | Downstream authority made stale | Earliest fallback |
| --- | --- | --- |
| creative brief | selects, blueprint, timeline, review report/patch | `intent_locked` |
| analysis artifact version | selects, blueprint, timeline, review report/patch | `media_analyzed` |
| selects or `STYLE.md` | blueprint, timeline, review report/patch | `selects_ready` |
| blueprint | timeline, review report/patch | `blueprint_ready` |
| timeline or human notes | review report/patch | `timeline_drafted` |
| review report/patch | approval binding must be reconsidered | `critique_ready` |
| caption approval or music cues | package QA and manifest | `approved` |
| package QA report | package manifest | `approved` |
| handoff source-of-truth decision | package QA and manifest | `approved` |

Approval becomes `stale` when its bound artifact versions no longer match.
Analysis overrides become stale when their recorded analysis version changes.
Package files cannot promote a project when the packaging gate is blocked, the
QA report is missing/malformed/not passed, or the manifest source of truth
differs from the current handoff decision.

Every automatic state correction appends a history entry with from/to state,
trigger, actor, timestamp, and a self-heal note. Atomic writes use a revision
guard where callers supply one; conflicting concurrent writes raise
`STATE_CONFLICT`.

## Preview versus final/package

`schemas/editorial-pipeline-status.schema.json` deliberately separates four
results:

- preview: `available`, `skipped`, or `missing`;
- QA: `passed`, `failed`, or `skipped`;
- final render: `not_requested` or `blocked`;
- package: `not_requested` or `blocked`.

If `blocking_issues` is non-empty, final render and package must be blocked
with `QA_LOOP_FAILED`, `QA_SKIPPED`, or `QA_RENDER_MISSING`. A preview may still
be available for diagnosis and human repair. Preview availability never
changes `approval_record` or makes the project `packaged`.

## Gate 10 and final authority

`runtime/packaging/gate10.ts` requires:

1. state `approved` or `packaged`;
2. approval `clean` or `creative_override`;
3. a decided source of truth (`engine_render` or `nle_finishing`), except the
   explicit full-autonomy engine-render default;
4. an open review gate;
5. no unapproved fatal review issue;
6. verified visual QA or an explicit reasoned waiver;
7. non-stale caption approval and music cues when present.

`runtime/commands/package.ts` then validates timeline/caption policy, measures
the chosen media, runs required package QA, writes the manifest, publishes the
final deliverable, and transitions state only on success. Treat `07_package/`
as internal package evidence and `09_output/final.mp4` as the published local
deliverable path.

## Resume semantics

`project_state.yaml.resume` may record a pending human step, questions, a
resume command, or last error. Resume from canonical artifacts and reconciled
state; do not rerun expensive analysis merely because a process or machine
restarted. Use:

```sh
npx tsx scripts/status.ts projects/<project-id>
npm run full-pipeline -- --project <project-id> --from <stage>
```

The exact `--from` timing stages accepted by the public full-pipeline adapter
are listed by `npm run full-pipeline -- --help` and
`runtime/pipeline/plan.ts`.
