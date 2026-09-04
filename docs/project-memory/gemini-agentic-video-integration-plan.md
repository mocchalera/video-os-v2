# Gemini Agentic Video Integration Plan

Status: M4a operator manual request integration implemented; whole-cut review provider and downstream pipeline hooks remain pending
Tracking issue: [#73](https://github.com/mocchalera/video-os-v2-dev/issues/73)
Parent objective: [#4](https://github.com/mocchalera/video-os-v2-dev/issues/4)
Baseline reviewed: `Dev@fbe79bf85b4e0bafb982eb479e621ad4841143cc`
Last reviewed: 2026-09-02 JST

## 1. Objective

Integrate Gemini Agentic Video Understanding without weakening Video OS's
local-first, artifact-driven, deterministic editing contract.

The intended topology is:

```text
source footage
  -> deterministic probes / STT / visual quality
  -> Marlin local temporal semantics (default whole-library observation)
  -> deterministic VideoReasoningRouter
       -> local evidence is sufficient: stop
       -> static frame-bundle VLM is sufficient: existing VlmFn
       -> high-value dynamic video reasoning is justified: Gemini Agentic Video
  -> provider-neutral evidence and uncertainty
  -> local timestamp/frame verification
  -> review suggestion or inspectable patch candidate
  -> existing runtime / human gate
  -> timeline.json
```

The feature is successful only when the hybrid route reduces human search or
revision work while preserving privacy, budget, provenance, fail-open behavior,
and canonical artifact authority.

## 2. Current baseline

This plan starts from the current Dev implementation rather than the older
public repository state.

### Existing capabilities to reuse

- `runtime/connectors/marlin-types.ts`, `marlin-local.ts`, the Python worker, and
  Marlin pipeline stages already provide bounded local caption/find operations,
  temporal events, checkpoint identity, chunking, degraded failure records, and
  source-bound provenance.
- `runtime/connectors/gemini-vlm.ts` already provides a provider-agnostic
  `VlmFn` for sampled frame bundles, schema-guided output, bounded token policy,
  grounding hashes, diagnostics, and one bounded repair path.
- `runtime/analysis-defaults.yaml` already separates `vlm`, `marlin`, budgets,
  parallelism, and cache identity fields.
- Issue #5 completed the bounded execution and provenance work needed for slow
  Marlin/editorial model paths.
- Issue #32 / PR #63 implemented model-agnostic observation, inference,
  uncertainty, alternatives, and whole-cut semantic review.
- Issue #44 established that optional visual-model availability and quality
  judgment are separate; provider loss must be reported without breaking the
  deterministic baseline.
- M7 already supports read-only timeline-scoped AI consultation and previewable
  patch handoff.

### Current authority constraints

- `runtime/pipeline/plan.ts` owns the canonical stage vocabulary.
- Optional connectors are capabilities, not artifact authorities.
- `timeline.json` remains the canonical timeline IR.
- Agents and model connectors may propose evidence or patches; deterministic
  runtime paths apply and persist accepted changes.
- Missing cloud access, model cache, or optional dependencies must not invalidate
  already-produced artifacts or deterministic compile/render behavior.

## 3. External capability assumptions

The implementation must re-check these assumptions against current official
Gemini documentation before the first live probe and whenever the model/API
version changes.

As reviewed on 2026-09-02:

- Agentic Video is exposed through the Gemini Interactions API.
- A video input selects the mode with `processing: "agentic"`.
- Supported launch models are Gemini 3.7 Flash, 3.6 Flash, and 3.5 Flash-Lite.
- Static mode remains appropriate for latency-sensitive short clips or uniform
  frame sampling; agentic mode is intended for long-form or targeted moment
  retrieval.
- `processing_call` and `processing_result` steps provide evidence that dynamic
  navigation actually occurred.
- Interactions supports JSON-schema response formatting.
- File API is preferred for reusable or larger/longer video; inline input is
  reserved for conservative small one-off payloads.

Official references:

- https://blog.google/innovation-and-ai/models-and-research/gemini-models/introducing-agentic-video-in-gemini/
- https://ai.google.dev/gemini-api/docs/video-understanding#agentic-video-understanding
- https://ai.google.dev/gemini-api/docs/interactions-overview
- https://ai.google.dev/gemini-api/docs/structured-output

Do not encode promotional benchmark maxima as Video OS acceptance thresholds.
Measure actual token use, latency, cost, and editorial value on Video OS fixtures.

## 4. Durable design decisions

### AV-001 — Marlin remains the default observation lane

Marlin runs locally across the relevant source library and produces the first
usable temporal map. Agentic Video is not a replacement for Marlin and must not
be required for baseline analysis.

### AV-002 — Preserve the existing static `VlmFn`

The current contract accepts extracted frame paths:

```ts
export type VlmFn = (
  framePaths: string[],
  prompt: string,
  options: VlmCallOptions,
) => Promise<VlmCallResult>;
```

Agentic Video accepts video bytes or a video URI and has a different interaction,
upload, step, state, and usage lifecycle. Implement it behind a separate
provider-neutral whole-video reasoning contract.

### AV-003 — No new canonical stage for the pilot

Do not add `agenticVideo` to the canonical stage vocabulary initially. Invoke the
capability from bounded hooks in analysis, triage, or review.

A stage may be proposed only after the pilot demonstrates a real need for its own
resume cursor, progress lifecycle, dependencies, and failure semantics. Any stage
promotion requires an ADR and explicit approval.

### AV-004 — Cloud use is explicit and project-scoped

The default policy is `local_only`. An API key alone is not consent to upload.
Cloud execution requires a project/operator policy that permits one of:

- `bounded_derivative`: upload only a configured proxy or selected range.
- `source_allowed`: upload the source asset when explicitly permitted.

### AV-005 — Provider timestamps are candidates, not edit truth

A provider-reported moment must be normalized, checked against source duration,
and locally verified around the candidate window before it can influence a trim
or patch candidate.

### AV-006 — Disagreement becomes uncertainty

Do not choose a winner merely because Agentic Video is newer or cloud-based.
Material disagreement among Marlin, static VLM, transcript/audio evidence, and
Agentic Video must enter the existing uncertainty/review contract.

### AV-007 — Unknown request outcome is not blindly retried

When the network fails after request submission and billing/result state cannot
be proven, record `outcome: unknown`. Do not automatically replay the same paid
request. An idempotent cache/ledger decision must precede any operator retry.

## 5. Responsibility matrix

| Need | Default lane | Escalation rule |
| --- | --- | --- |
| Whole-library scene/event map | Marlin | No automatic cloud escalation |
| Short-clip tags, framing, visible subject | Existing static VLM | Agentic only when temporal meaning cannot be resolved from sampled frames |
| Long-form needle search | Agentic Video | Requires cloud policy and budget |
| Expression, gaze, hand movement, action boundary | Marlin + local dense frames | Agentic when candidates conflict or editorial impact is high |
| Exact frame validation | FFmpeg/local inspection | Never delegate final authority to Agentic |
| Whole-cut narrative/continuity review | Existing #32 contract | Agentic is an optional evidence provider |
| Confidential/no-upload project | Marlin/local only | Escalation forbidden |

## 6. Proposed contracts

Create `runtime/connectors/video-reasoning-types.ts` and keep provider concerns
out of the shared types.

```ts
export type VideoReasoningTask =
  | "needle_search"
  | "moment_refine"
  | "trim_refine"
  | "continuity_check"
  | "roughcut_review"
  | "anomaly_inspection";

export type VideoReasoningPrivacy =
  | "local_only"
  | "bounded_derivative"
  | "source_allowed";

export interface VideoReasoningSource {
  asset_id: string;
  path: string;
  source_content_sha256: string;
  duration_us: number;
  range_us?: [number, number];
  mime_type?: string;
}

export interface VideoReasoningBudget {
  max_requests: number;
  max_uploaded_duration_us: number;
  max_uploaded_bytes: number;
  max_estimated_input_tokens?: number;
  max_estimated_usd?: number;
}

export interface VideoReasoningRequest {
  task: VideoReasoningTask;
  source: VideoReasoningSource;
  prompt: string;
  prompt_contract_version: string;
  output_schema_version: string;
  privacy: VideoReasoningPrivacy;
  budget: VideoReasoningBudget;
}

export interface VideoReasoningObservation {
  start_us?: number;
  end_us?: number;
  observation: string;
  inference?: string;
  editorial_intent?: string;
  confidence: number;
  uncertainty?: string;
  evidence_refs: string[];
}

export interface VideoReasoningEvidence {
  artifact_version: "video_reasoning_evidence/v1";
  provider: "gemini";
  model_alias: string;
  processing_requested: "agentic" | "static";
  processing_observed: "agentic" | "static" | "unverified";
  provider_request_id?: string;
  source: Omit<VideoReasoningSource, "path">;
  prompt_hash: string;
  response_schema_version: string;
  observations: VideoReasoningObservation[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    thought_tokens?: number;
    tool_use_tokens?: number;
  };
  execution: {
    started_at: string;
    completed_at?: string;
    elapsed_ms?: number;
    status: "complete" | "degraded" | "failed" | "unknown";
    failure_class?: string;
    processing_call_count?: number;
    processing_result_count?: number;
  };
}
```

The exact field names may be adjusted to reuse the #32 judgment contract, but the
following invariants are mandatory:

- observation and inference remain distinct;
- source hash and range are mandatory;
- provider/model/prompt/schema/processing identities are retained;
- filesystem paths, raw prompts, secrets, and upload URIs are excluded from
  tracked evidence;
- `processing_requested: agentic` does not imply
  `processing_observed: agentic`;
- usage and execution status are optional/degraded honestly, never fabricated.

## 7. Router design

Create `runtime/connectors/video-reasoning-router.ts`. The router is
configuration-driven and deterministic; it does not ask an LLM whether money may
be spent.

### Hard guards

```text
project cloud opt-in exists
AND privacy permits the chosen upload form
AND task is enabled
AND source/range identity is valid
AND request budget remains
AND byte/duration budget remains
AND provider/model capability is available
```

### Escalation signals

At least one must be present:

- long-form targeted retrieval;
- Marlin result is degraded or below configured confidence;
- more than one materially different local candidate remains;
- the decision has high editorial impact;
- whole-cut semantic evaluation is explicitly requested;
- local/static evidence cannot observe the necessary temporal change.

### Suggested decision result

```ts
interface VideoReasoningRouteDecision {
  decision: "local" | "static_vlm" | "agentic" | "blocked";
  reasonCodes: string[];
  constraints: Record<string, unknown>;
  sourceRangeUs: [number, number] | null;
  estimatedUploadBytes: number | null;
  estimatedUploadDurationUs: number | null;
  budget: {
    before: Record<string, number | null>;
    reservation: Record<string, unknown>;
    afterReservation: Record<string, number | null>;
  };
}
```

Reserve budget before network work. Release the reservation only when the call is
proven not to have been submitted. Unknown outcomes remain reserved until an
operator resolves them.

### Initial routing defaults

- Under 5 minutes and latency-sensitive: prefer local/static unless targeted
  moment reasoning clearly benefits from agentic navigation.
- Ten minutes or longer with a targeted query: agentic is eligible after policy
  and budget checks.
- Apply the long-form threshold to the validated effective requested range; a
  short bounded range from a long source is not long-form for routing.
- `roughcut_review`: eligible regardless of length only when the operator requests
  semantic review and the rough render is explicitly allowed for upload.
- `local_only`: keep a usable Marlin lane local without constructing a cloud
  client; block only when no valid local lane remains. A `static_vlm` route also
  requires a non-local privacy mode with matching consent.

These are defaults, not universal quality claims. Pilot measurements may change
the thresholds.

### M2 router slice implementation truth

The bounded M2 implementation adds the pure
`decideVideoReasoningRoute()` contract in
`runtime/connectors/video-reasoning-router.ts`. It accepts explicit task,
privacy/consent, source-range/derivative identity, Marlin availability and
confidence/coverage, candidate conflict/uncertainty, editorial impact, provider
capabilities, and bounded budget estimates. It returns one of `local`,
`static_vlm`, `agentic`, or `blocked`, fixed reason codes, evaluated constraint
statuses, and a deterministic preflight reservation preview.

`local_only` is the safe default; an API-key indicator is ignored. The router
does not import or invoke a provider, read paths/prompts, mutate a ledger, add a
pipeline stage, or write project artifacts. Marlin evidence is sufficient for a
local stop, static-sufficient short cases remain on the existing frame-bundle
contract, and Agentic is admitted only after deterministic escalation, consent,
capability, identity, and budget guards pass. A blocked/deferred cloud route
leaves the local lane available to the caller.

This slice does not implement the private File API cache, request ledger,
automatic pipeline hooks, local timestamp verification, pilot, or benchmark.

## 8. Gemini adapter

Create `runtime/connectors/gemini-agentic-video.ts`.

### Input lifecycle

1. Validate source identity, range, policy, and budget.
2. Generate a bounded derivative when policy is `bounded_derivative`.
3. Use inline input only below a conservative configured byte threshold and for a
   one-off short request.
4. Otherwise upload with File API and cache the provider file identity privately.
5. Call `interactions.create` with video input and
   `processing: "agentic"`.
6. Request JSON-schema output through `response_format`.
7. Validate response against the repository-owned schema.
8. Inspect steps for `processing_call` and `processing_result`.
9. Normalize usage, status, and observations.
10. Persist tracked evidence without upload URI, raw prompt, or credentials.

### SDK boundary

`@google/genai` is already present in the lockfile. Before coding, confirm the
installed package API exposes the required Interactions methods and response
fields. If not, prefer a narrowly typed REST adapter over an unrelated dependency
upgrade. Any SDK upgrade must be isolated and verified against existing Gemini
connectors.

### File cache and request ledger

Proposed local-only, gitignored state:

```text
.video-os/private-cache/gemini-file-registry.json
.video-os/private-cache/agentic-request-ledger.json
```

File registry key:

```text
source_content_sha256
+ derivative specification
+ mime type
+ provider project/account scope
```

Evidence/cache key:

```text
source_content_sha256
+ source range
+ model alias/snapshot
+ processing mode
+ normalized prompt hash
+ prompt contract version
+ output schema version
```

The registry stores bounded provider identifiers and expiry/status metadata only.
It must not be committed or copied into package/export artifacts.

## 9. Configuration

Extend the existing analysis policy loader rather than introducing a competing
configuration system.

Proposed defaults:

```yaml
video_reasoning:
  enabled: false
  mode: local_only

  agentic:
    model_alias: gemini-3.7-flash
    processing: agentic
    allowed_tasks:
      - needle_search
      - moment_refine
      - trim_refine
      - continuity_check
      - roughcut_review
      - anomaly_inspection

  upload:
    policy: never
    inline_max_bytes: 20971520
    derivative_max_duration_us: 30000000

  budget:
    max_requests: 0
    max_uploaded_duration_us: 0
    max_uploaded_bytes: 0

  escalation:
    longform_min_duration_us: 600000000
    require_high_impact_or_uncertainty_for_short_form: true
```

A project/operator override may enable `bounded_derivative` or `source_allowed`,
but environment presence alone must never change `mode` from `local_only`.

Do not assume exact dollar cost can always be known before dynamic navigation.
Use request, byte, duration, and conservative token reservations for every
non-local provider route during preflight; record actual token/cost information
after the response when available.

## 10. Evidence and artifact placement

Proposed tracked, derived evidence:

```text
03_analysis/video_reasoning_evidence.jsonl
03_analysis/video_reasoning_route_report.json
06_review/agentic_video_review.json
```

These files are inspectable analysis/review evidence. They do not supersede
`selects_candidates.yaml`, `edit_blueprint.yaml`, `review_report.yaml`, or
`timeline.json`.

Before adding a new schema/artifact, implementation must check whether the #32
judgment evidence can carry the normalized observations directly. Prefer
extending an intentional extension point or reusing an existing evidence
container over creating duplicate canonical truth.

### Local verification record

For each provider candidate used by planning/review, store a separate local check:

```ts
interface LocalMomentVerification {
  provider_observation_id: string;
  requested_window_us: [number, number];
  verified_window_us?: [number, number];
  frame_timestamps_us: number[];
  source_content_sha256: string;
  outcome: "confirmed" | "adjusted" | "rejected" | "inconclusive";
  rationale_code: string;
}
```

Do not silently overwrite the provider timestamp with the local timestamp; retain
both for evaluation.

## 11. Implementation milestones

### M0 — Contract freeze and probe design

Deliverables:

- this plan and Issue #73;
- exact mapping to current #32 evidence and uncertainty types;
- exact policy-loader insertion point;
- read-only probe CLI contract;
- no runtime behavior change.

Exit criteria:

- no new canonical source of truth;
- no change to existing `VlmFn`;
- no new pipeline stage;
- privacy and authority rules are testable.

### M1 — Read-only provider probe

Suggested files:

```text
runtime/connectors/video-reasoning-types.ts
runtime/connectors/gemini-agentic-video.ts
runtime/validation/video-reasoning-response-validator.ts
scripts/agentic-video-probe.ts
tests/gemini-agentic-video.test.ts
```

The probe must:

- accept one explicitly supplied rights-cleared video or derivative;
- require explicit cloud permission;
- write no canonical project artifact by default;
- prove structured response parsing;
- prove whether processing steps indicate agentic navigation;
- print/store sanitized usage and timing;
- classify timeout, unavailable, schema-invalid, and unknown outcomes.

### M2 — Router, budget, and private cache

Suggested files:

```text
runtime/connectors/video-reasoning-router.ts
runtime/connectors/gemini-video-file-cache.ts
runtime/connectors/video-reasoning-ledger.ts
tests/video-reasoning-router.test.ts
tests/video-reasoning-ledger.test.ts
```

The current implementation slice covers only the pure router and its focused
tests. Both `static_vlm` and `agentic` return a deterministic provider preflight
reservation; the caller must apply it before network work and retain it after an
unknown submitted outcome. Private cache/ledger lifecycle remains a follow-up
within this milestone; no provider upload or automatic route execution is
enabled here. The Marlin `degraded` constraint is reported as a guard status
(`pass` when healthy, `fail` when degraded, `not_applicable` when unavailable,
and `unknown` when not established).

Exit criteria:

- `local_only` constructs no Gemini client and performs no network call;
- budget reservation is deterministic for every provider route;
- upload policy cannot be bypassed by prompt or model output;
- duplicate and unknown request handling are covered;
- private cache is excluded by repo hygiene checks.

### M3 — Evidence normalization and local timestamp verification

Deliverables:

- reuse or narrowly extend #32 evidence structures;
- source-bound normalized output;
- FFmpeg dense-frame verification helper;
- uncertainty routing for disagreement;
- artifact/schema tests.

Exit criteria:

- out-of-range timestamps are rejected;
- provider and local timing remain separately inspectable;
- no provider response can directly mutate `timeline.json`.

M3b implementation boundary: `video-reasoning-local-verification/v1` is an
independent strict, source-bound artifact. Its bounded dense-frame lane is
FFmpeg-backed with an injectable runner for zero-network tests; missing tools,
decode failure, and assessor absence remain explicit inconclusive/unavailable
evidence. The provider request range is M3a's effective source range; local
verification samples a deterministic candidate +/- 500ms window clamped to
that range, with half-open timestamps and run-owned temporary output. The pure
disagreement router returns `review_required` uncertainty without selecting a
provider or granting timeline authority. M3a remains provider-only with
`local_verification.status=not_run` and empty records.

### M4 — Analysis and review integration

Integration order:

1. explicit CLI/manual request;
2. optional whole-cut review provider;
3. optional short-listed candidate refinement;
4. only then consider automatic escalation.

Do not begin with whole-library automatic uploads.

Exit criteria:

- unavailable Agentic Video degrades to current Marlin/static behavior;
- route reason and budget use are inspectable;
- whole-cut review reuses #32 rather than creating a parallel critic;
- inspectable patch preview remains the only path toward timeline mutation.

M4a implementation boundary: `runtime/connectors/video-reasoning-coordinator.ts`
provides the provider-neutral runtime coordinator for single-asset,
single-query operator manual requests (`scripts/agentic-video-request.ts`).
Deterministic M2 routing executes first; non-agentic routes result in 0
connector calls and 0 paid ledger writes. Agentic routes require both
project-scoped policy opt-in (`projectOptIn`) and operator consent, with cloud
media resolved from the private Gemini file registry (`lookupGeminiFileRegistry`)
instead of raw unverified URIs. Registered input requires an exact caller-supplied
registry key, explicit Gemini project/account scope, source and submitted-media
identities, and a privacy-compatible derivative specification; bounded
derivatives never fall back to an original-source URI. Unconfirmed capabilities
fail closed, and the manual CLI does not synthesize provider capability or
source-bound Marlin health from opt-in flags.
A narrow two-stage seam commits the ledger `submitted` transition via
`onBeforeSubmit` before transport; transport is allowed only when that transition
returns `submitted` with `allowed: true`, pre-submit failures release reservation,
while post-submit network crashes record unknown. Provider results normalize to
M3a derived evidence artifacts; normalization failures are recorded as truthful
post-submit failures rather than false successes. M3b local timestamp
verification strictly separates local source media from upload derivatives,
reporting explicit `source_unavailable` or `source_mismatch`, and disagreement
routing yields `review_required` with `timeline_authority: "none"`. Canonical
project artifacts, `timeline.json`, and stages remain untouched. Output
summaries are strictly secret-free and path-redacted, and CLI stdout is pure
single parseable JSON.

### M5 — Studio visibility

Optional after runtime proof:

- show privacy mode and upload scope;
- show why a route was selected;
- show provider/model/processing observed;
- show request and usage budget;
- show degraded/unknown outcomes;
- require explicit operator action for source upload.

Studio work is not a blocker for M1-M3 if the CLI policy is explicit and safe.

### M6 — Pilot and adoption decision

Run both the short-form project pilot and an independent long-form benchmark.
Produce one report containing quality, timing, usage, cost, privacy, failure, and
human-effort results. Do not enable Agentic Video by default until that report is
reviewed.

## 12. Test matrix

### Contract and schema

- valid structured response;
- missing required evidence identity;
- timestamp outside source/range;
- observation/inference conflation or empty evidence refs;
- unsupported processing/model combination;
- provider says agentic but response steps do not prove it.

### Router

- `local_only` never constructs or calls provider;
- short clip with strong Marlin evidence -> local/static;
- short high-impact conflicting candidates -> eligible Agentic route;
- long-form targeted query -> eligible Agentic route;
- budget exhausted -> no provider upload; defer to usable Marlin or block when
  no safe local lane remains;
- invalid source upload/derivative preparation -> no provider upload; defer to
  usable Marlin or block when no safe local lane remains;
- missing API key -> degraded local route, not false success.

### Upload/cache/ledger

- same source hash and derivative spec reuses valid file identity;
- source content change invalidates cache;
- prompt/schema/model/processing change invalidates evidence cache;
- timeout before submission releases reservation;
- timeout after possible submission remains unknown/reserved;
- private registry never appears in tracked/package outputs.

### Failure semantics

- provider unavailable;
- File API processing failed;
- request timeout;
- malformed response envelope;
- structured output validation failure;
- missing usage fields;
- `processing_call` without matching result;
- partial/unknown response.

### Integration

- Marlin-only pipeline remains green;
- static VLM route remains unchanged;
- deterministic compile/render tests remain green;
- review suggestion cannot mutate timeline without current patch/apply gate;
- exact remote SHA, Node 22 typecheck, targeted tests, and repo-hygiene checks pass.

Live API tests remain opt-in and rights-cleared. CI must use fixtures/mocks and
must not require a Gemini key.

## 13. task 2502dc08 short-form pilot

This project contains short narrative clips, so it is not evidence that Agentic
is always better than static processing. Limit the experiment to four questions:

1. For the sequence of photographs, locate the first readable, most stable, and
   last useful moment for each image.
2. Identify meaningful transitions among walking, slowing, stopping, gaze shift,
   and photo inspection rather than merely listing body motion.
3. Compare the rooftop character shot and empty-rooftop/envelope shot to propose
   up to three continuity/afterimage cut candidates.
4. Review the completed rough cut as a whole for missing information, repeated
   meaning, premature cuts, and highest-value additional material.

Constraints:

- maximum four Agentic requests;
- `bounded_derivative` unless the operator explicitly approves source upload;
- no task-specific rule enters generic runtime code;
- every timestamp used downstream is locally verified;
- no automatic timeline mutation;
- compare Marlin-only, Marlin + static VLM, Agentic-only, and Marlin-first hybrid.

Metrics:

- top-candidate recall against human-selected moments;
- absolute edit-point delta in milliseconds;
- accepted suggestion rate;
- useful findings unique to each route;
- human search/review time;
- upload bytes/duration;
- actual token breakdown and cost when available;
- end-to-end latency;
- disagreement and local-verification outcomes.

## 14. Independent long-form benchmark

Use at least one rights-cleared source of ten minutes or longer. Include a known
needle-in-a-haystack set with human-verified moments. Compare:

- current static processing;
- Agentic processing;
- Marlin-only local retrieval;
- Marlin shortlist followed by Agentic refinement.

Do not adopt default routing based solely on Google's published maxima or the
short-form pilot. Adoption requires Video OS-specific evidence that hybrid routing
improves editorial utility per cost/latency/privacy constraint.

## 15. Rollout and rollback

### Rollout

1. docs and Issue only;
2. read-only probe behind explicit flag;
3. router disabled by default;
4. project-scoped opt-in pilot;
5. whole-cut review integration;
6. shortlist refinement;
7. default-policy decision only after evaluation.

### Rollback

- set `video_reasoning.enabled: false` or `mode: local_only`;
- retain provider evidence for audit but stop new requests;
- invalidate private file identities if credentials/account scope changes;
- continue from Marlin/static artifacts without re-ingest;
- never require removal or migration of canonical timeline artifacts.

## 16. Human gates

Human approval is required for:

- permitting original-source upload;
- increasing project request/upload/cost limits;
- enabling automatic escalation by default;
- promoting Agentic Video to a canonical pipeline stage;
- accepting a provider suggestion that changes high-impact story truth when
  evidence remains uncertain.

No human gate is required for docs, mock tests, type contracts, or a local-only
router path.

## 17. Immediate next implementation slice

The first code PR should contain only M1 foundations:

1. inspect current #32 evidence types and choose reuse vs narrow extension;
2. add provider-neutral request/result types;
3. add a Gemini Interactions adapter with dependency injection and structured
   response validation;
4. add a read-only probe CLI with explicit upload consent;
5. add mock tests for processing-step verification, schema parsing, timeout, and
   secret-free diagnostics;
6. do not wire automatic pipeline escalation yet.

This keeps the first review small enough to prove the API and authority boundary
before routing, uploads, and runtime orchestration are combined.
