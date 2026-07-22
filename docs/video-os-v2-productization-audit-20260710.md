# Video OS v2 productization audit — 2026-07-10

## Decision

The headline from the 2026-06-05 assessment remains valid:

> Video OS v2 is an advanced prototype, but it is not yet one product.

The reason needs updating. As of commit `8dd88144`, the repository already has a
project state machine, a canonical runtime pipeline plan/executor, deterministic
timeline patches, a capable native Studio, quality rubrics, a golden-eval harness,
and NLE revision diffs. The remaining product gap is not the absence of those
mechanisms. It is the absence of one enforced product contract and one human-approved
speech-led golden path that prove the mechanisms work together.

The P0 product contract should be:

> Given Japanese speech-led interview, seminar, or event footage plus a brief,
> Video OS produces an evidence-backed, human-editable 60–180 second rough cut,
> lets an editor review and revise it in Studio, and exports an editable NLE handoff.

Do not add a parallel pipeline or rename the canonical artifacts to implement this.
Use `interview-highlight`, the existing artifact/state contracts, the runtime-owned
pipeline, Studio's current edit/preview lifecycle, and the existing eval/handoff
surfaces.

## Scope and evidence

This is a live repository audit, not a line-by-line revalidation of the 2026-06-05
source document.

- Branch and commit: `Dev` at `8dd8814467c190449a36fd86e6fe291392622b15`
- Internal GitHub Actions run `29063263116` started 2026-07-10 10:49:51 JST
  and completed 10:50:58 JST. The private development-repository URL is not
  part of the OSS snapshot.
- Local toolchain used for cross-check: Apple Swift 6.2.4, Node 22.x project
  dependencies already installed
- Project Loop: after explicit Cockpit human approval, migrations
  `007_evidence_links` and `008_event_outbox` were applied; `pcl validate` and
  `pcl render` then passed

## Latest CI cross-check

The job-level notification in the assessment is correct.

| Job | Result | Audit interpretation |
|---|---|---|
| `repo-hygiene` | Pass | Repository boundary checks are active. |
| `agent-definitions` | Pass | Generated agent definitions are synchronized. |
| `editor-server` | Pass | The editor server typechecks when its own dependencies are installed. |
| `schema-contract` | Pass | The focused schema contract suite passes. |
| `macos-studio` | Fail | The code is not compatible with the CI runner's Swift 5.10 compiler. |
| `node-runtime` | Fail | The root TypeScript boundary pulls an editor-server route into a clean root install without editor dependencies. |

The failures are narrower than “the whole E2E route is broken,” but they are still
release-blocking contract failures.

### `macos-studio`

The macOS runner uses Apple Swift 5.10. It rejects:

- trailing commas in `SubprocessRunner.run(...)` and `Output(...)` at
  `apps/macos-studio/Sources/VideoOSStudioCore/SubprocessRunner.swift:24` and `:81`;
- `.compactMap(\.self)` inference at
  `apps/macos-studio/Sources/VideoOSStudioCore/TimelineAgentReviewPatchApplyPlan.swift:199`.

The same checkout passes locally on Swift 6.2.4: `swift test` executed 516 tests with
0 failures. This is a minimum-supported-toolchain mismatch, not evidence that the
Studio test suite is generally failing.

### `node-runtime`

The root job runs `npm ci` and then `npm run build`. Root `tsconfig.json` includes
all tests. `tests/editor-server-media-roots.test.ts` imports
`editor/server/routes/thumbnails.ts`, which imports `express`. `express` and its
types are owned by `editor/package.json`, not the root package. The dedicated
`editor-server` job installs those dependencies and passes, while the clean root job
fails with TS2307 plus implicit-`any` follow-on errors.

The local `npm run build` passes because `editor/node_modules` is already present.
This is dependency leakage between CI responsibility boundaries.

## Pass / Concern / Fail audit

| Priority from the assessment | Status | Current evidence | Required correction |
|---|---|---|---|
| Fix the first video type | **Fail** | `interview-highlight` exists, but eight editorial profiles remain product-visible in the repository and the default golden suite is `fumoto-growth`, `togakushi-camp`, and `ena-promo` rather than a speech-led product fixture. | Make `interview-highlight` the only default first-run product route. Keep other profiles available only as explicit advanced/experimental choices. |
| Separate core, profiles, and skills | **Concern** | `runtime/pipeline`, `runtime/editorial/profiles`, and `runtime/editorial/skills` are real separations. Profiles select reusable skills. Some compiler behavior still branches on concrete profile IDs, so the boundary is not fully declarative. | Freeze the current contract; move only golden-path-critical profile branches behind policy/skill contracts. Do not create per-profile pipelines. |
| Make the agent follow a state machine | **Concern** | `ARCHITECTURE.md`, `schemas/project-state.schema.json`, and `runtime/state/reconcile.ts` already implement persistent state and gates. Studio also gates jobs by artifact readiness. The project state machine, runtime stage plan, and UI readiness model are separate representations without one product E2E proof that they remain synchronized. | Test allowed next actions, resume, backtrack, and artifact invalidation through one speech-led fixture. Avoid adding a second state model. |
| Make Studio the human decision cockpit | **Pass with guardrail** | Studio already supports Viewer/Timeline/Inspector, source monitoring, direct trim/split/ripple/roll/slip/overwrite operations, candidate search, QA, AI patch preview, apply/undo/promote, and export. It is more than a review dashboard. | Keep AI contextual and preview-first, but do not demote Studio to review-only. Basic direct editing is an accepted product requirement. Pause net-new editing features until the golden path is proven. |
| Measure quality and human correction | **Concern** | `review_metrics.json`, Marlin visual QA, the integrated golden suite, and `human_revision_diff` already exist. Project Loop records F-0022 through F-0035 as passing. The golden suite is not a required CI job, has no speech-led default project, and does not aggregate time-to-first-usable-cut, human intervention time, kept-cut ratio, or accepted-proposal ratio. | Add product outcome metrics as projections from existing run, patch, and NLE-diff data. Gate a human-approved speech-led golden in CI. |

## Corrections to the 2026-06-05 assessment

### Already implemented or substantially implemented

1. **Persistent state machine**
   - `project_state.yaml` persists `intent_pending` through `packaged`.
   - Approval, analysis override, handoff resolution, hashes, gates, history, and
     resume information are schema-backed.
2. **Runtime-owned pipeline**
   - `runtime/pipeline/plan.ts` owns the canonical stage/phase definitions.
   - `runtime/pipeline/executor.ts` owns the full-pipeline orchestration.
   - `scripts/full-pipeline.ts` is a CLI adapter.
3. **Deterministic edit boundary**
   - Agents propose bounded patch operations.
   - Compiler/Studio paths validate and preview before timeline mutation.
4. **Operator Studio**
   - The M6 direct-editing slice is complete and M6.5 contains extensive editing
     ergonomics. The outstanding issue is product focus, not basic edit capability.
5. **Evaluation and NLE correction evidence**
   - Deterministic review metrics cover story, rhythm, emotion, eye trace, 2D plane,
     and audio.
   - Golden evaluation and Marlin visual QA exist.
   - NLE round-trip produces a structured human revision diff.
6. **Profile and skill libraries**
   - `interview-highlight`, `lecture-highlight`, `event-recap`, and other profiles
     compose named editing skills rather than owning standalone pipelines.

### Still missing at product level

1. One explicit default input/output contract.
2. One human-approved speech-led golden project with reproducible fixture policy.
3. One E2E test that traverses brief, analysis, story, cut, review, Studio readiness,
   and NLE export under the persisted state rules.
4. CI green on the declared Node and Swift compatibility boundaries.
5. Product outcome telemetry based on editor effort and accepted/rejected changes.
6. A first-run Studio route that hides experimental profile breadth.

## Do not duplicate the artifact model

The assessment proposes useful domain names, but most already map to canonical
artifacts. Introducing new parallel sources of truth would recreate the problem the
assessment is trying to solve.

| Proposed concept | Existing source of truth |
|---|---|
| `IntentBrief` | `01_intent/creative_brief.yaml` |
| `EditorialProgram` | resolved profile/policy and constraints in the brief/blueprint/compiler inputs |
| `MaterialMap` / `EvidenceGraph` | assets, segments, transcripts, analysis graphs, and `footage.db` |
| `StoryBeat[]` | `04_plan/edit_blueprint.yaml` beats |
| `CoverageMap` | analysis coverage, must-have coverage, and beat candidate coverage |
| `CandidateSet` | `04_plan/selects_candidates.yaml` |
| `TimelinePatch` | `06_review/review_patch.json` and Studio patch/session operations |
| `TimelineVersion` | `05_timeline/timeline.json` version/hash |
| `ReviewReport` | review report, review metrics, visual QA, and package QA artifacts |
| `DecisionLog` | `project_state.yaml` history, human notes, editor annotations, and approval records |

If a missing field is required, evolve the nearest existing contract additively. Do
not create a second canonical document solely to match new terminology.

## P0 golden path contract

### Input

- Japanese speech-led interview, seminar, or event recording
- Initial support target: one primary camera; additional cameras/B-roll are optional
- Transcript evidence available, or an explicit human-approved degraded path
- Creative brief with audience, desired action, 60–180 second target, must-haves,
  prohibitions, tone, aspect ratio, and delivery target
- Profile fixed to `interview-highlight` for the first product route

### Output

- inspectable beat/story structure in the existing blueprint
- candidates with evidence and selection rationale
- playable rough cut and captions
- basic dialogue intelligibility and loudness handling
- Studio-editable timeline with preview/apply/undo
- MP4 review output
- editable Premiere/NLE handoff with stable IDs and round-trip report

### Excluded from P0

- automatic generative-video gap filling
- MV/PV-first visual-only editing
- advanced VFX, grading, and complex multicam synchronization
- automatic optimization for every social platform
- expanding the profile or editing-skill catalog
- new Studio editing features unrelated to completing the golden path

## P0 execution sequence

### Gate 0 — Restore CI truth

1. Make Studio source compile and test on the CI-declared Swift 5.10 toolchain, or
   explicitly raise the minimum toolchain and install it in CI.
2. Make the root Node build independent of `editor/node_modules`; keep editor-server
   coverage in its dedicated job or install dependencies deliberately in a declared
   workspace boundary.
3. Require all six responsibility jobs to pass on `Dev`.

Exit criterion: one clean GitHub Actions run on the same branch and commit under
review.

### Gate 1 — Freeze the product contract

Write one short normative document that fixes input, output, default profile,
exclusions, degraded behavior, and success metrics. Map every concept to the existing
canonical artifacts.

Status: **Complete on 2026-07-10.** The normative contract is
`docs/speech-led-highlight-product-contract.md`. It fixes `interview-highlight` /
`interview`, the 60–180 second output boundary, existing state/artifact authority,
degraded behavior, exclusions, and product outcome metrics without adding a parallel
schema or pipeline.

Exit criterion: no implementation decision for P0 requires choosing a genre, output
shape, state authority, or source-of-truth artifact.

### Gate 2 — Establish the speech-led human golden

Use `lively-alt-vol5` as the first candidate because it already uses
`interview-highlight` and contains a 90-second dialogue digest, review metrics, and
render/package artifacts. It is **not currently a valid golden**: its persisted
`project_state.current_state` is `blueprint_ready` and it lacks a current operator
approval record. Reconcile it, verify rights/fixture policy, and require explicit
human approval before promotion. If its media cannot be used as a durable fixture,
create a small rights-cleared replacement without committing private source footage.

Exit criterion: one operator-approved speech-led golden is discovered by the eval
registry and has frozen brief, analysis inputs, selects, blueprint, timeline, review,
and export expectations.

Status: **Complete on 2026-07-10.** `lively-alt-vol5` timeline v2 is rights-confirmed,
operator-approved, and discovered by the golden registry as `tier=human`. Its local
private source and rendered reference remain untracked. Automated Marlin visual QA
timed out and is explicitly not counted as passing; that fail-closed regression work
remains in Gate 5 / T-0016. See
`reports/project-control-loop/2026-07-10-lively-alt-vol5-human-golden.md`.

### Gate 3 — Prove one resumable E2E route

Drive the existing `full-pipeline` and state contracts; do not create a new
orchestrator. Verify:

- clean start from brief/source registration;
- fail-open optional local models;
- stage interruption and resume;
- backtrack after review;
- deterministic compile/patch validation;
- Studio readiness and human edit preview/apply/undo;
- MP4 review output and NLE export;
- artifact/state invalidation after upstream edits.

Exit criterion: a single report identifies every stage, artifact hash/version,
duration, degraded lane, human gate, and final outcome.

Status: **Complete on 2026-07-10.** The approved `lively-alt-vol5` v3 route resumed
after a PC restart at Gate 9, packaged through the existing state machine, rendered
a 91.333-second 24 fps / 48 kHz MP4 with 60 px captions, produced a warning-free
Studio exact preview, and exported a Premiere XML that dry-run imported 12/12 clips
with zero diff. Optional Marlin visual QA remains explicitly blocked rather than
counted as passing. See
`reports/project-control-loop/2026-07-10-speech-led-resumable-e2e.md`.

### Gate 4 — Add product outcome metrics

Derive metrics from existing evidence before inventing new manual logs:

- time to first usable cut;
- human intervention minutes;
- kept-cut ratio;
- accepted/rejected AI proposal ratio;
- post-export edit distance from `human_revision_diff`;
- rerun duration and cost/degraded-mode markers.

Exit criterion: the golden run emits a stable productization summary and a human can
compare it with the previous accepted run.

### Gate 5 — Make Studio expose the product route

Make the first-run path read as `Brief → Sources → Story → Cut → Review → Export`
using the existing implementation. `interview-highlight` is the default; other
profiles are explicit advanced/experimental choices. AI remains a contextual,
preview-first collaborator. Direct editing remains available.

Exit criterion: a new user can take the golden project from import to NLE export
without knowing CLI commands or internal artifact filenames.

### Gate 6 — Make regression mandatory

- fast artifact/contract test on pull requests;
- Swift and Node boundary jobs green;
- human speech-led golden structure/alignment on pull requests where affordable;
- real-media render/Marlin QA on scheduled or explicitly invoked runs;
- no success when visual QA is unavailable or mocked.

Exit criterion: a regression cannot merge while appearing green through skipped,
mocked, or dependency-leaking checks.

## Interaction with existing Project Loop goals

- **G-0001 (macOS refactor/UI/UX):** preserve completed M6/M6.5 capability. Pause
  net-new feature slices; only golden-path defects and usability blockers are P0.
- **G-0002 (quality/eval trust):** reuse F-0022–F-0035. Add the speech-led human
  golden and product outcome metrics instead of another evaluation stack.
- **G-0003 (third-party review governance):** CI defects are first. Defer the large
  `T-0006` Studio decomposition until the compatibility baseline is green and the
  golden contract is frozen; otherwise the refactor moves a red baseline.

## Stop conditions

Until Gates 0–3 are complete, do not:

- add profiles or editing skills;
- add model providers;
- add generative video to the default route;
- start another pipeline/state/artifact abstraction;
- continue broad Studio feature accretion;
- claim “automatic finished video” as the product contract.

## Final assessment

Video OS v2 has moved materially beyond the 2026-06-05 implementation snapshot.
Several recommendations in that assessment are now existing assets, not future work.
The productization conclusion is still correct: the repository needs one enforced
speech-led contract, one approved golden, one resumable E2E proof, green CI, and
editor-effort metrics. That is the shortest route from an advanced prototype to one
coherent product.
