import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { validateAgainstSchema } from "../commands/shared.js";
import { computeNormalizedJsonHash } from "../artifacts/p1-manifest-coverage.js";
import { inspectImmutableRecordFile } from "../review/review-rounds-ledger.js";
import type { HumanCorrectionApprovalBinding } from "../state/reconcile.js";
import {
  HUMAN_CORRECTION_DOMAINS,
  HUMAN_CORRECTION_REASONS,
  normalizeHumanCorrections,
  type HumanCorrectionDomain,
  type HumanCorrectionNote,
  type HumanCorrectionReason,
} from "../review/human-corrections.js";
import {
  deriveReviewRoundsMetric,
  inspectImmutableYamlFile,
  listRevisionDiffCandidates,
  type ReviewRoundEvidence,
  type ReviewRoundsMetric,
  type ValidatedRevisionDiff,
} from "./review-rounds.js";

export type MetricStatus = "measured" | "estimated" | "unavailable";

export interface ProductMetric {
  status: MetricStatus;
  value: number | Record<string, unknown> | null;
  unit: string;
  method: string;
  numerator?: number;
  denominator?: number;
  evidence: string[];
  limitations: string[];
}

export interface ProductOutcomeMetrics {
  version: "1.1.0";
  artifact_version: "product-outcome-metrics-v1";
  project_id: string;
  created_at: string;
  report_id: string;
  timeline: {
    path: string;
    version: string;
    hash: string;
    duration_sec: number;
    video_clip_count: number;
  };
  metrics: {
    time_to_first_usable_cut: ProductMetric;
    human_intervention_minutes: ProductMetric;
    kept_cut_ratio: ProductMetric;
    accepted_proposal_ratio: ProductMetric;
    post_export_edit_distance: ProductMetric;
    review_issue_density: ProductMetric;
    rerun_duration: ProductMetric;
    rerun_cost: ProductMetric;
    review_rounds: ReviewRoundsMetric;
    human_correction_summary: HumanCorrectionSummaryMetric;
  };
  degraded_run_flags: DegradedRunFlag[];
  evidence_roles: {
    maker: string[];
    deterministic_validator: string[];
    checker: string[];
    human_preference: string[];
  };
  provenance: {
    producer: "scripts/product-outcome-metrics.ts";
    inputs: Array<{ path: string; hash: string; required: boolean }>;
    hash_policy: {
      algorithm: "sha256";
      canonicalization: "normalized-json-v1";
      excluded_fields: ["created_at", "report_id"];
    };
  };
}

export interface DegradedRunFlag {
  code: string;
  severity: "info" | "warning" | "blocker";
  message: string;
  evidence: string[];
}

export interface TimelineClip {
  clip_id?: string;
  exchange_clip_id?: string;
  segment_id?: string;
  asset_id?: string;
  src_in_us?: number;
  src_out_us?: number;
  timeline_in_frame?: number;
  timeline_duration_frames?: number;
  candidate_ref?: string;
}

export interface TimelineDoc {
  version?: string | number;
  project_id?: string;
  sequence?: { fps_num?: number; fps_den?: number };
  tracks?: Record<string, Array<{ clips?: TimelineClip[] }>>;
}

interface ProjectStateDoc {
  project_id?: string;
  history?: Array<{
    to_state?: string;
    actor?: string;
    trigger?: string;
    timestamp?: string;
    note?: string;
  }>;
  approval_record?: {
    status?: string;
    approved_at?: string;
    approved_by?: string;
    artifact_versions?: {
      timeline_version?: string;
      base_timeline_version?: string;
      editorial_timeline_hash?: string;
      human_notes_hash?: string;
      human_correction_approval?: HumanCorrectionApprovalBinding;
    };
  };
  analysis_override?: { status?: string; reason?: string };
  gates?: { analysis_gate?: string };
}

export interface HumanNotesDoc {
  version?: string | number;
  project_id?: string;
  notes?: HumanCorrectionNote[];
}

interface ReviewReportDoc {
  created_at?: string;
  summary_judgment?: { status?: string };
  weaknesses?: unknown[];
  fatal_issues?: unknown[];
  warnings?: unknown[];
  mismatches_to_brief?: unknown[];
  mismatches_to_blueprint?: unknown[];
  visual_qa?: { status?: string; reason?: string };
  visual_qa_waiver?: boolean;
  visual_qa_waiver_reason?: string;
}

interface ProgressDoc {
  phase?: string;
  status?: string;
  started_at?: string;
  updated_at?: string;
  errors?: unknown[];
}

interface PipelineTimingsDoc {
  runs?: Array<{
    run_id?: string;
    status?: string;
    started_at?: string;
    completed_at?: string;
    stages?: Array<{ status?: string; stage?: string; error?: string }>;
  }>;
}

interface HumanRevisionDiffDoc {
  summary?: Record<string, number>;
  operations?: Array<{
    operation_id?: string;
    type?: string;
    target?: {
      exchange_clip_id?: string;
      clip_id?: string;
      segment_id?: string;
      asset_id?: string;
      track_id?: string;
    };
    delta?: { in_us?: number; out_us?: number; duration_frames?: number };
  }>;
  unmapped_edits?: unknown[];
  identity?: {
    base_timeline?: { path?: string; version?: string; sha256?: string };
    review_generation?: {
      generation_id?: string;
      review_identity?: string;
      output?: { path?: string; sha256?: string };
      review_ready_receipt?: { path?: string; sha256?: string };
    };
    review_round?: { round_index?: number; round_identity?: string };
  };
}

interface LoadedArtifact<T> {
  relativePath: string;
  absolutePath: string;
  data: T;
  /** Precomputed byte hash from the single immutable read snapshot (no re-open). */
  hashOverride?: string;
}

/** @internal hostile-test seam; normal report builders leave this unset. */
export interface ProductOutcomeMetricsBuildOptions {
  onResponseArtifactCaptured?: (artifact: { path: string; sha256: string }) => void;
  /** @internal hostile-test seam for a timeline namespace swap after capture. */
  onTimelineCaptured?: (artifact: { path: string; sha256: string }) => void;
}

export interface HumanCorrectionSummaryTimeline {
  path: string;
  version: string;
  sha256: string;
  data: TimelineDoc;
}

export interface HumanCorrectionSummaryNotes {
  path: string;
  sha256: string;
  data: HumanNotesDoc;
}

export interface HumanCorrectionSummaryCorrection {
  note_id: string;
  reason: HumanCorrectionReason;
  domain: HumanCorrectionDomain;
  stable_clip_ref: string;
}

export type HumanCorrectionReasonCounts = Record<HumanCorrectionReason, number>;
export type HumanCorrectionDomainCounts = Record<HumanCorrectionDomain, number>;
export type HumanCorrectionOperationCounts = Record<
  "trim" | "reorder" | "enable_disable" | "track_move" | "simple_transition" | "timeline_marker_add" | "unmapped",
  number
>;

export interface HumanCorrectionSummaryValue {
  project_id: string;
  base_timeline: Omit<HumanCorrectionSummaryTimeline, "data">;
  approved_timeline: Omit<HumanCorrectionSummaryTimeline, "data">;
  human_notes: { path: string; sha256: string };
  review_generation: {
    generation_id: string;
    review_identity: string;
    output: { path: string; sha256: string };
    review_ready_receipt: { path: string; sha256: string };
  };
  review_round: { round_index: number; round_identity: string };
  human_revision_diff: { path: string; sha256: string; version: 2 };
  corrections: HumanCorrectionSummaryCorrection[];
  counts: {
    correction_count: number;
    by_reason: HumanCorrectionReasonCounts;
    by_domain: HumanCorrectionDomainCounts;
    by_operation: HumanCorrectionOperationCounts;
    trim_delta_us: number;
    cut_delta: number;
    base_video_clip_count: number;
    approved_video_clip_count: number;
  };
  completeness: "complete";
}

export interface HumanCorrectionSummaryMetric {
  status: "measured" | "unavailable";
  value: HumanCorrectionSummaryValue | null;
  unit: "corrections";
  method: "identity_bound_human_correction_summary";
  numerator?: number;
  denominator?: number;
  evidence: string[];
  limitations: string[];
}

export interface HumanCorrectionSummaryInput {
  projectId: string;
  baseTimeline: HumanCorrectionSummaryTimeline;
  approvedTimeline: HumanCorrectionSummaryTimeline | null;
  humanNotes: HumanCorrectionSummaryNotes | null;
  approvalRecord: ProjectStateDoc["approval_record"];
  reviewRound: ReviewRoundEvidence | null;
  revisionDiff: ValidatedRevisionDiff | null;
  /** False when diff discovery saw any malformed, foreign, stale, or ambiguous candidate. */
  revisionDiffSelectionComplete: boolean;
  /** False when the immutable base/approved snapshots cannot be revalidated. */
  timelineIntegrityComplete: boolean;
  unavailableReason?: string | null;
}

const TIMELINE_PATH = "05_timeline/timeline.json";
const APPROVED_TIMELINE_PATH = "05_timeline/approved.timeline.json";
const OUTPUT_PATH = "08_eval/product_outcome_metrics.json";
const HUMAN_NOTES_PATH = "06_review/human_notes.yaml";
const HUMAN_REVISION_OPERATION_TYPES = [
  "trim",
  "reorder",
  "enable_disable",
  "track_move",
  "simple_transition",
  "timeline_marker_add",
] as const;

export function computeProductOutcomeMetricsHash(report: unknown): string {
  return computeNormalizedJsonHash(report, ["created_at", "report_id"]);
}

export function buildProductOutcomeMetrics(
  projectDirInput: string,
  createdAt = new Date().toISOString(),
  options: ProductOutcomeMetricsBuildOptions = {},
): ProductOutcomeMetrics {
  const projectDir = fs.realpathSync(path.resolve(projectDirInput));
  const malformed: DegradedRunFlag[] = [];
  const timeline = loadRequiredTimeline(projectDir, TIMELINE_PATH);
  const approvedTimeline = loadApprovedTimeline(projectDir, malformed);
  const state = loadOptionalYaml<ProjectStateDoc>(projectDir, "project_state.yaml", malformed);
  const humanNotes = loadHumanNotesYaml(projectDir, malformed);
  const reviewReport = loadOptionalYaml<ReviewReportDoc>(projectDir, "06_review/review_report.yaml", malformed);
  const reviewPatch = loadOptionalJson<Record<string, unknown>>(projectDir, "06_review/review_patch.json", malformed);
  const reviewMetrics = loadOptionalJson<Record<string, unknown>>(projectDir, "06_review/review_metrics.json", malformed);
  const progress = loadOptionalJson<ProgressDoc>(projectDir, "progress.json", malformed);
  const pipelineTimings = loadOptionalJson<PipelineTimingsDoc>(projectDir, "03_analysis/pipeline-timings.json", malformed);
  const baseline = loadBaselineTimeline(projectDir, malformed);
  let revisionDiffDiscoveryComplete = true;
  const revisionDiffCandidates = listRevisionDiffCandidates(projectDir, (code, message, evidence) => {
    revisionDiffDiscoveryComplete = false;
    malformed.push({ code, severity: "warning", message, evidence });
  });
  const reviewAsk = loadOptionalJson<Record<string, unknown>>(projectDir, "06_review/review-ask.json", malformed);
  const reviewResponse = loadOptionalJson<Record<string, unknown>>(projectDir, "06_review/review-response.json", malformed);

  options.onTimelineCaptured?.({ path: TIMELINE_PATH, sha256: timeline.hashOverride ?? sha256File(timeline.absolutePath) });
  if (approvedTimeline) {
    options.onTimelineCaptured?.({
      path: approvedTimeline.relativePath,
      sha256: approvedTimeline.hashOverride ?? sha256File(approvedTimeline.absolutePath),
    });
  }

  const fps = timeline.data.sequence?.fps_num && timeline.data.sequence?.fps_den
    ? timeline.data.sequence.fps_num / timeline.data.sequence.fps_den
    : 0;
  const currentClips = videoClips(timeline.data);
  const durationFrames = currentClips.reduce(
    (max, clip) => Math.max(max, (clip.timeline_in_frame ?? 0) + (clip.timeline_duration_frames ?? 0)),
    0,
  );
  const durationSec = fps > 0 ? round(durationFrames / fps, 3) : 0;
  const projectId = timeline.data.project_id ?? state?.data.project_id ?? path.basename(projectDir);
  const timelineHash = timeline.hashOverride ?? sha256File(timeline.absolutePath);
  const timelineVersion = String(timeline.data.version ?? "unknown");

  const timeToFirstUsableCut = deriveTimeToFirstUsableCut(state);
  const humanIntervention = deriveHumanInterventionMinutes(state, humanNotes);
  const keptCutRatio = deriveKeptCutRatio(baseline, timeline);
  const acceptedProposalRatio = deriveAcceptedProposalRatio(humanNotes, timeline, reviewPatch);
  const reviewIssueDensity = deriveReviewIssueDensity(reviewReport, durationSec);
  const rerunDuration = deriveRerunDuration(pipelineTimings, progress);
  const rerunCost = unavailableMetric(
    "currency",
    "provider_cost_artifact",
    [],
    "No canonical provider-cost artifact is available; cost is not inferred from duration or model names.",
  );
  const reviewRounds = deriveReviewRoundsMetric({
    projectDir,
    projectId,
    timeline: { path: TIMELINE_PATH, version: timelineVersion, hash: timelineHash },
    askPointer: reviewAsk?.data ?? null,
    responsePointer: reviewResponse?.data ?? null,
    revisionDiffCandidates,
    onResponseArtifactCaptured: options.onResponseArtifactCaptured,
  });
  const selectedDiffArtifact = reviewRounds.validatedRevisionDiff
    ? {
      relativePath: reviewRounds.validatedRevisionDiff.relativePath,
      data: reviewRounds.validatedRevisionDiff.document as HumanRevisionDiffDoc,
    }
    : null;
  const selectedRound = reviewRounds.validatedRevisionDiff && reviewRounds.metric.value
    ? reviewRounds.metric.value.rounds.find((round) =>
      round.round_identity === reviewRounds.validatedRevisionDiff!.round.round_identity)
    ?? null
    : null;
  const revisionDiffSelectionComplete = revisionDiffDiscoveryComplete
    && !reviewRounds.flags.some((flag) => flag.code.includes("revision_diff"));
  const timelineIntegrityComplete = verifyTimelineSnapshots(projectDir, timeline, approvedTimeline);
  const humanCorrectionSummary = deriveHumanCorrectionSummary({
    projectId,
    baseTimeline: {
      path: TIMELINE_PATH,
      version: timelineVersion,
      sha256: timelineHash,
      data: timeline.data,
    },
    approvedTimeline: approvedTimeline
      ? {
        path: approvedTimeline.relativePath,
        version: String(approvedTimeline.data.version ?? "unknown"),
        sha256: approvedTimeline.hashOverride ?? sha256File(approvedTimeline.absolutePath),
        data: approvedTimeline.data,
      }
      : null,
    humanNotes: humanNotes
      ? {
        path: humanNotes.relativePath,
        sha256: humanNotes.hashOverride ?? sha256File(humanNotes.absolutePath),
        data: humanNotes.data,
      }
      : null,
    approvalRecord: state?.data.approval_record,
    reviewRound: selectedRound,
    revisionDiff: reviewRounds.validatedRevisionDiff,
    revisionDiffSelectionComplete,
    timelineIntegrityComplete,
    unavailableReason: reviewRounds.metric.status === "unavailable"
      ? reviewRounds.metric.limitations[0]
      : reviewRounds.revisionDiffUnavailableReason,
  });
  const postExportEditDistance = selectedDiffArtifact
    ? derivePostExportEditDistance(selectedDiffArtifact)
    : unavailableMetric(
      "operations",
      "canonical_human_revision_diff",
      revisionDiffCandidates,
      reviewRounds.revisionDiffUnavailableReason
        ?? "No identity-bound human_revision_diff.yaml is available; foreign or stale diffs are never measured.",
    );

  const degradedRunFlags = [
    ...deriveDegradedFlags(state, reviewReport, progress, pipelineTimings),
    ...malformed,
    ...reviewRounds.flags,
  ].sort((a, b) => a.code.localeCompare(b.code));

  const inputArtifacts = uniqueArtifacts([
    timeline,
    approvedTimeline,
    state,
    humanNotes,
    reviewReport,
    reviewPatch,
    reviewMetrics,
    progress,
    pipelineTimings,
    baseline,
    reviewAsk,
    reviewResponse,
    // Every ledger event plus generation, QA, render, audio, and attestation
    // receipts consumed by the review-rounds derivation join the provenance.
    ...reviewRounds.provenanceArtifacts.map((artifact) => ({
      relativePath: artifact.relativePath,
      absolutePath: artifact.absolutePath,
      data: null as unknown,
      hashOverride: artifact.sha256,
    })),
  ]);
  const requiredPaths = new Set([TIMELINE_PATH]);
  const evidenceRoles = {
    maker: existingPaths(projectDir, [TIMELINE_PATH, "04_plan/selects_candidates.yaml", "04_plan/edit_blueprint.yaml"]),
    deterministic_validator: existingPaths(projectDir, [
      "06_review/review_metrics.json",
      "progress.json",
      "03_analysis/pipeline-timings.json",
      ...(reviewRounds.validatedRevisionDiff ? [reviewRounds.validatedRevisionDiff.relativePath] : []),
    ]),
    checker: existingPaths(projectDir, ["06_review/review_report.yaml"]),
    human_preference: existingPaths(projectDir, ["06_review/human_notes.yaml", "project_state.yaml"]),
  };

  const report: ProductOutcomeMetrics = {
    version: "1.1.0",
    artifact_version: "product-outcome-metrics-v1",
    project_id: projectId,
    created_at: createdAt,
    report_id: "POM_0000000000000000",
    timeline: {
      path: TIMELINE_PATH,
      version: timelineVersion,
      hash: timelineHash,
      duration_sec: durationSec,
      video_clip_count: currentClips.length,
    },
    metrics: {
      time_to_first_usable_cut: timeToFirstUsableCut,
      human_intervention_minutes: humanIntervention,
      kept_cut_ratio: keptCutRatio,
      accepted_proposal_ratio: acceptedProposalRatio,
      post_export_edit_distance: postExportEditDistance,
      review_issue_density: reviewIssueDensity,
      rerun_duration: rerunDuration,
      rerun_cost: rerunCost,
      review_rounds: reviewRounds.metric,
      human_correction_summary: humanCorrectionSummary,
    },
    degraded_run_flags: degradedRunFlags,
    evidence_roles: evidenceRoles,
    provenance: {
      producer: "scripts/product-outcome-metrics.ts",
      inputs: inputArtifacts
        .map((artifact) => ({
          path: artifact.relativePath,
          hash: artifact.hashOverride ?? sha256File(artifact.absolutePath),
          required: requiredPaths.has(artifact.relativePath),
        }))
        .sort((a, b) => a.path.localeCompare(b.path)),
      hash_policy: {
        algorithm: "sha256",
        canonicalization: "normalized-json-v1",
        excluded_fields: ["created_at", "report_id"],
      },
    },
  };
  report.report_id = `POM_${computeProductOutcomeMetricsHash(report).slice("sha256:".length, "sha256:".length + 16)}`;
  return report;
}

export function writeProductOutcomeMetrics(
  projectDirInput: string,
  outputPathInput?: string,
  createdAt = new Date().toISOString(),
): { outputPath: string; report: ProductOutcomeMetrics; hash: string } {
  const projectDir = path.resolve(projectDirInput);
  const report = buildProductOutcomeMetrics(projectDir, createdAt);
  const validation = validateAgainstSchema(report, "product-outcome-metrics.schema.json");
  if (!validation.valid) {
    throw new Error(`Product outcome metrics failed schema validation: ${validation.errors.join("; ")}`);
  }
  const outputPath = outputPathInput ? path.resolve(outputPathInput) : path.join(projectDir, OUTPUT_PATH);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const tempPath = `${outputPath}.tmp.${process.pid}`;
  fs.writeFileSync(tempPath, `${JSON.stringify(report, null, 2)}\n`, "utf-8");
  fs.renameSync(tempPath, outputPath);
  return { outputPath, report, hash: computeProductOutcomeMetricsHash(report) };
}

function deriveTimeToFirstUsableCut(state: LoadedArtifact<ProjectStateDoc> | null): ProductMetric {
  const history = state?.data.history ?? [];
  const events = history
    .map((event) => ({ event, time: timestampMs(event.timestamp) }))
    .filter((item): item is { event: NonNullable<ProjectStateDoc["history"]>[number]; time: number } => item.time !== null)
    .sort((a, b) => a.time - b.time);
  const start = events[0];
  const approved = events.find(({ event }) =>
    event.to_state === "approved" && (
      /operator/i.test(event.actor ?? "") ||
      /operator/i.test(event.trigger ?? "") ||
      /operator accepted|operator approved/i.test(event.note ?? "")
    )
  );
  if (!state || !start || !approved || approved.time < start.time) {
    return unavailableMetric(
      "seconds",
      "state_history_to_first_approved",
      state ? [state.relativePath] : [],
      "A durable project start and explicit approved transition are both required.",
    );
  }
  return {
    status: "measured",
    value: round((approved.time - start.time) / 1000, 3),
    unit: "seconds",
    method: "state_history_to_first_approved",
    evidence: [state.relativePath],
    limitations: ["Measures elapsed wall time between durable state events, not uninterrupted compute time."],
  };
}

function deriveHumanInterventionMinutes(
  state: LoadedArtifact<ProjectStateDoc> | null,
  humanNotes: LoadedArtifact<HumanNotesDoc> | null,
): ProductMetric {
  const events: number[] = [];
  for (const note of humanNotes?.data.notes ?? []) {
    if (!/operator|human|editor/i.test(note.reviewer ?? "")) continue;
    const time = timestampMs(note.timestamp);
    if (time !== null) events.push(time);
  }
  const approvalTime = timestampMs(state?.data.approval_record?.approved_at);
  if (approvalTime !== null && /operator|human|editor/i.test(state?.data.approval_record?.approved_by ?? "")) {
    events.push(approvalTime);
  }
  const sorted = [...new Set(events)].sort((a, b) => a - b);
  const evidence = [humanNotes?.relativePath, state?.relativePath].filter((item): item is string => Boolean(item));
  if (sorted.length < 2) {
    return unavailableMetric(
      "minutes",
      "operator_event_span_proxy",
      evidence,
      "At least two durable human events are required; active editing time is never inferred from one timestamp.",
    );
  }
  return {
    status: "estimated",
    value: round((sorted[sorted.length - 1] - sorted[0]) / 60_000, 3),
    unit: "minutes",
    method: "operator_event_span_proxy",
    evidence,
    limitations: ["This is the elapsed span between human events, not active hands-on editing time."],
  };
}

function deriveKeptCutRatio(
  baseline: LoadedArtifact<TimelineDoc> | null,
  current: LoadedArtifact<TimelineDoc>,
): ProductMetric {
  if (!baseline) {
    return unavailableMetric(
      "ratio",
      "baseline_clip_retention",
      [current.relativePath],
      "No versioned baseline timeline is available.",
    );
  }
  const baselineClips = videoClips(baseline.data);
  const currentClips = videoClips(current.data);
  if (baselineClips.length === 0) {
    return unavailableMetric(
      "ratio",
      "baseline_clip_retention",
      [baseline.relativePath, current.relativePath],
      "The baseline timeline contains no video clips.",
    );
  }
  const retained = baselineClips.filter((clip) => currentClips.some((candidate) => clipsMatch(clip, candidate))).length;
  return {
    status: "measured",
    value: round(retained / baselineClips.length, 6),
    unit: "ratio",
    method: "baseline_clip_retention",
    numerator: retained,
    denominator: baselineClips.length,
    evidence: [baseline.relativePath, current.relativePath],
    limitations: ["A cut is retained only by stable clip/candidate identity or at least 50% source-range overlap on the same asset and segment."],
  };
}

function deriveAcceptedProposalRatio(
  humanNotes: LoadedArtifact<HumanNotesDoc> | null,
  timeline: LoadedArtifact<TimelineDoc>,
  reviewPatch: LoadedArtifact<Record<string, unknown>> | null,
): ProductMetric {
  const directives = (humanNotes?.data.notes ?? []).filter((note) =>
    Boolean(note.directive_type) && note.directive_type !== "observation"
  );
  const evidence = [humanNotes?.relativePath, timeline.relativePath, reviewPatch?.relativePath]
    .filter((item): item is string => Boolean(item));
  if (directives.length === 0) {
    return unavailableMetric(
      "ratio",
      "explicit_human_directive_acceptance",
      evidence,
      "No human directive with explicit acceptance markers is available.",
    );
  }
  const clips = videoClips(timeline.data);
  const clipIds = new Set(clips.map((clip) => clip.clip_id).filter(Boolean));
  const segmentIds = new Set(clips.map((clip) => clip.segment_id).filter(Boolean));
  const candidateRefs = new Set(clips.map((clip) => clip.candidate_ref).filter(Boolean));
  const accepted = directives.filter((note) => {
    if (note.approved_segment_ids?.some((id) => segmentIds.has(id))) return true;
    if (note.clip_refs?.some((id) => candidateRefs.has(id))) return true;
    if (note.directive_type === "remove_segment" && note.clip_ids?.every((id) => !clipIds.has(id))) return true;
    return false;
  }).length;
  return {
    status: "measured",
    value: round(accepted / directives.length, 6),
    unit: "ratio",
    method: "explicit_human_directive_acceptance",
    numerator: accepted,
    denominator: directives.length,
    evidence,
    limitations: ["Review-patch operations without a durable applied/accepted marker are excluded from the denominator."],
  };
}

interface HumanRevisionDiffCounts {
  byOperation: HumanCorrectionOperationCounts;
  trimDeltaUs: number;
}

/**
 * Project one approved, identity-bound human correction surface.  This is
 * deliberately a pure join over already captured artifacts: review-rounds
 * owns generation/round/diff authentication, while this function only
 * verifies the cross-artifact bindings needed by the product metric.
 */
export function deriveHumanCorrectionSummary(
  input: HumanCorrectionSummaryInput,
): HumanCorrectionSummaryMetric {
  const fail = (reason: string): HumanCorrectionSummaryMetric =>
    unavailableHumanCorrectionSummary(input, reason);

  if (!input.projectId || !input.revisionDiffSelectionComplete || !input.timelineIntegrityComplete) {
    return fail(input.revisionDiffSelectionComplete && input.timelineIntegrityComplete
      ? "Project identity is missing; human corrections cannot be measured."
      : !input.timelineIntegrityComplete
        ? "Base or approved timeline failed immutable revalidation; timeline swaps, symlinks, and TOCTOU reads are never measured."
        : "Human revision diff discovery or validation was incomplete; foreign, stale, unbound, or ambiguous diffs are never measured.");
  }
  if (!input.humanNotes) {
    return fail("06_review/human_notes.yaml is missing or failed immutable/schema validation; human corrections are unavailable.");
  }
  if (input.humanNotes.path !== HUMAN_NOTES_PATH
    || !isCanonicalSha256(input.humanNotes.sha256)) {
    return fail("Human notes are not bound to the canonical path and byte hash.");
  }
  if (input.humanNotes.data.project_id !== input.projectId) {
    return fail("human_notes.yaml binds a foreign project identity and is rejected.");
  }
  const notesValidation = validateAgainstSchema(input.humanNotes.data, "human-notes.schema.json");
  if (!notesValidation.valid || !Array.isArray(input.humanNotes.data.notes)) {
    return fail("human_notes.yaml failed the canonical schema or note-list validation.");
  }
  const noteIds = new Set<string>();
  for (const note of input.humanNotes.data.notes) {
    if (!note || typeof note.id !== "string" || note.id.length === 0 || noteIds.has(note.id)) {
      return fail("human_notes.yaml contains a missing or duplicate note identity.");
    }
    noteIds.add(note.id);
  }
  if (!input.approvedTimeline) {
    return fail("No immutable approved timeline snapshot is available; approval is not projected from an unbound current file.");
  }
  const baseTimelineError = validateSummaryTimeline(input.baseTimeline, input.projectId, "base");
  if (baseTimelineError) return fail(baseTimelineError);
  const approvedTimelineError = validateSummaryTimeline(input.approvedTimeline, input.projectId, "approved");
  if (approvedTimelineError) return fail(approvedTimelineError);
  if (input.baseTimeline.path === input.approvedTimeline.path
    && (input.baseTimeline.version !== input.approvedTimeline.version
      || input.baseTimeline.sha256 !== input.approvedTimeline.sha256)) {
    return fail("Base and approved timeline identities collide at one path but have different versions or hashes.");
  }
  if (!input.reviewRound) {
    return fail("No verified review round is available; an approval response is required for correction measurement.");
  }
  if (input.reviewRound.response.decision !== "approve") {
    return fail("The identity-bound review round has no approve decision; request-changes and free-text rounds are not approved corrections.");
  }
  if (!input.revisionDiff) {
    return fail(input.unavailableReason
      ?? "No identity-bound v2 human_revision_diff.yaml is available; legacy or unbound diffs are never measured.");
  }
  const approvalError = validateApprovalBinding(
    input.approvalRecord,
    input.approvedTimeline,
    input.humanNotes,
    input.reviewRound,
    input.revisionDiff,
  );
  if (approvalError) return fail(approvalError);
  const diffCounts = readHumanRevisionDiffCounts(input.revisionDiff.document);
  if (!diffCounts) {
    return fail("The identity-bound v2 human_revision_diff.yaml has inconsistent operation or unmapped-edit counts.");
  }

  const sourceSha256 = input.humanNotes.sha256.slice("sha256:".length);
  const normalizedCorrections = normalizeHumanCorrections(
    { notes: input.humanNotes.data.notes },
    { sourcePath: HUMAN_NOTES_PATH, sourceSha256 },
  );
  const corrections: HumanCorrectionSummaryCorrection[] = [];
  const byReason = emptyHumanCorrectionReasonCounts();
  const byDomain = emptyHumanCorrectionDomainCounts();
  const clipIndex = buildStableClipIndex([input.baseTimeline.data, input.approvedTimeline.data]);
  for (const correction of normalizedCorrections) {
    if (!isHumanCorrectionReason(correction.reason)) {
      return fail(`Human correction ${correction.note_id} has a reason outside the existing bounded taxonomy.`);
    }
    const domain = correction.source_note.domain ?? "unknown";
    if (!isHumanCorrectionDomain(domain)) {
      return fail(`Human correction ${correction.note_id} has a domain outside the bounded taxonomy.`);
    }
    byReason[correction.reason] += 1;
    byDomain[domain] += 1;
    corrections.push({
      note_id: correction.note_id,
      reason: correction.reason,
      domain,
      stable_clip_ref: resolveStableClipRef(correction.source_note, clipIndex),
    });
  }
  corrections.sort((left, right) => left.note_id.localeCompare(right.note_id, "en"));

  const baseVideoClipCount = videoClips(input.baseTimeline.data).length;
  const approvedVideoClipCount = videoClips(input.approvedTimeline.data).length;
  const evidence = humanCorrectionSummaryEvidence(input);
  return {
    status: "measured",
    value: {
      project_id: input.projectId,
      base_timeline: omitTimelineData(input.baseTimeline),
      approved_timeline: omitTimelineData(input.approvedTimeline),
      human_notes: { path: input.humanNotes.path, sha256: input.humanNotes.sha256 },
      review_generation: {
        generation_id: input.reviewRound.generation_id,
        review_identity: input.reviewRound.review_identity,
        output: input.reviewRound.output,
        review_ready_receipt: input.reviewRound.review_ready_receipt,
      },
      review_round: {
        round_index: input.reviewRound.round_index,
        round_identity: input.reviewRound.round_identity,
      },
      human_revision_diff: {
        path: input.revisionDiff.relativePath,
        sha256: input.revisionDiff.sha256,
        version: 2,
      },
      corrections,
      counts: {
        correction_count: corrections.length,
        by_reason: byReason,
        by_domain: byDomain,
        by_operation: diffCounts.byOperation,
        trim_delta_us: diffCounts.trimDeltaUs,
        cut_delta: approvedVideoClipCount - baseVideoClipCount,
        base_video_clip_count: baseVideoClipCount,
        approved_video_clip_count: approvedVideoClipCount,
      },
      completeness: "complete",
    },
    unit: "corrections",
    method: "identity_bound_human_correction_summary",
    numerator: corrections.length,
    evidence,
    limitations: [
      "Reasons use the existing human-corrections taxonomy; omitted domains and unmatched or ambiguous clip references are emitted as unknown.",
      "Operation counts and trim delta come only from the canonical v2 human_revision_diff; no operation is inferred from note prose.",
      "cut_delta is the approved-minus-base video clip count and is not a claim about editorial quality.",
    ],
  };
}

function unavailableHumanCorrectionSummary(
  input: HumanCorrectionSummaryInput,
  reason: string,
): HumanCorrectionSummaryMetric {
  return {
    status: "unavailable",
    value: null,
    unit: "corrections",
    method: "identity_bound_human_correction_summary",
    evidence: humanCorrectionSummaryEvidence(input),
    limitations: [reason],
  };
}

function humanCorrectionSummaryEvidence(input: HumanCorrectionSummaryInput): string[] {
  return uniqueSorted([
    input.baseTimeline.path,
    input.approvedTimeline?.path ?? APPROVED_TIMELINE_PATH,
    HUMAN_NOTES_PATH,
    "06_review/review-rounds",
    input.reviewRound?.timeline.path ?? null,
    input.reviewRound?.output.path ?? null,
    input.reviewRound?.review_ready_receipt.path ?? null,
    input.reviewRound?.ask.event_path ?? null,
    input.reviewRound?.response.event_path ?? null,
    input.reviewRound?.response.artifact.path ?? null,
    input.revisionDiff?.relativePath ?? null,
  ]);
}

function validateSummaryTimeline(
  timeline: HumanCorrectionSummaryTimeline,
  projectId: string,
  role: "base" | "approved",
): string | null {
  const expectedPath = role === "base" ? TIMELINE_PATH : null;
  if (!isSafeRelativeArtifactPath(timeline.path)
    || (expectedPath && timeline.path !== expectedPath)
    || (!expectedPath && timeline.path !== TIMELINE_PATH && timeline.path !== APPROVED_TIMELINE_PATH)) {
    return `${role} timeline path is not a canonical project-relative path.`;
  }
  if (!isCanonicalSha256(timeline.sha256)) return `${role} timeline hash is not canonical.`;
  if (!timeline.data || typeof timeline.data !== "object" || Array.isArray(timeline.data)) {
    return `${role} timeline document is not a mapping.`;
  }
  if (timeline.data.project_id !== projectId) return `${role} timeline binds a foreign project identity.`;
  if (timeline.data.version === undefined || timeline.data.version === null
    || timeline.version !== String(timeline.data.version) || timeline.version.length === 0) {
    return `${role} timeline version does not match its document identity.`;
  }
  return null;
}

function validateApprovalBinding(
  approvalRecord: ProjectStateDoc["approval_record"],
  approvedTimeline: HumanCorrectionSummaryTimeline,
  humanNotes: HumanCorrectionSummaryNotes,
  reviewRound: ReviewRoundEvidence,
  revisionDiff: ValidatedRevisionDiff,
): string | null {
  if (!approvalRecord || (approvalRecord.status !== "clean" && approvalRecord.status !== "creative_override")) {
    return "Approval record is absent, pending, stale, or otherwise not an approved state.";
  }
  const versions = approvalRecord.artifact_versions;
  if (!versions) return "Approval record has no artifact_versions binding.";
  const binding = versions.human_correction_approval;
  if (!binding || binding.version !== "human-correction-approval/v1") {
    return "Approval record has no complete human-correction approval evidence binding.";
  }
  if (binding.approved_timeline.path !== approvedTimeline.path
    || binding.approved_timeline.version !== approvedTimeline.version
    || binding.approved_timeline.sha256 !== approvedTimeline.sha256) {
    return "Approval approved-timeline identity does not match the immutable approved snapshot.";
  }
  if (binding.human_notes.path !== humanNotes.path || binding.human_notes.sha256 !== humanNotes.sha256) {
    return "Approval human-notes identity does not match the immutable canonical notes artifact.";
  }
  if (binding.review_generation.generation_id !== reviewRound.generation_id
    || binding.review_generation.review_identity !== reviewRound.review_identity
    || binding.review_generation.output.path !== reviewRound.output.path
    || binding.review_generation.output.sha256 !== reviewRound.output.sha256
    || binding.review_generation.review_ready_receipt.path !== reviewRound.review_ready_receipt.path
    || binding.review_generation.review_ready_receipt.sha256 !== reviewRound.review_ready_receipt.sha256) {
    return "Approval generation identity does not match the authoritative validated review round.";
  }
  if (binding.review_round.round_index !== reviewRound.round_index
    || binding.review_round.round_identity !== reviewRound.round_identity) {
    return "Approval round identity does not match the authoritative validated review round.";
  }
  if (binding.human_revision_diff.path !== revisionDiff.relativePath
    || binding.human_revision_diff.sha256 !== revisionDiff.sha256
    || binding.human_revision_diff.version !== 2) {
    return "Approval human revision diff identity does not match the authoritative validated v2 diff.";
  }
  return null;
}

function readHumanRevisionDiffCounts(document: Record<string, unknown>): HumanRevisionDiffCounts | null {
  const summary = asRecord(document.summary);
  if (!summary) return null;
  const byOperation = emptyHumanCorrectionOperationCounts();
  for (const [kind, count] of Object.entries(summary)) {
    if (!isHumanRevisionOperationKey(kind) && kind !== "unmapped") return null;
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) return null;
  }
  const unmappedEdits = document.unmapped_edits;
  if (unmappedEdits !== undefined && !Array.isArray(unmappedEdits)) return null;
  if ((summary.unmapped ?? 0) !== (unmappedEdits?.length ?? 0)) return null;
  const operations = document.operations;
  if (operations !== undefined && !Array.isArray(operations)) return null;
  const operationIds = new Set<string>();
  let trimDeltaUs = 0;
  for (const operationValue of operations ?? []) {
    const operation = asRecord(operationValue);
    const target = operation ? asRecord(operation.target) : null;
    const operationId = operation?.operation_id;
    const operationType = operation?.type;
    if (!operation || typeof operationId !== "string" || operationId.length === 0
      || operationIds.has(operationId) || !isHumanRevisionOperationKey(operationType)
      || !target || typeof target.exchange_clip_id !== "string") {
      return null;
    }
    operationIds.add(operationId);
    byOperation[operationType] += 1;
    const delta = operation.delta;
    if (delta !== undefined) {
      const deltaRecord = asRecord(delta);
      if (!deltaRecord) return null;
      for (const field of ["in_us", "out_us", "duration_frames"] as const) {
        if (deltaRecord[field] !== undefined && !Number.isSafeInteger(deltaRecord[field])) return null;
      }
      if (operationType === "trim") {
        trimDeltaUs += Math.abs((deltaRecord.in_us as number | undefined) ?? 0)
          + Math.abs((deltaRecord.out_us as number | undefined) ?? 0);
        if (!Number.isSafeInteger(trimDeltaUs)) return null;
      }
    }
  }
  for (const operationType of HUMAN_REVISION_OPERATION_TYPES) {
    const declaredCount = typeof summary[operationType] === "number" ? summary[operationType] : 0;
    if (byOperation[operationType] !== declaredCount) return null;
  }
  byOperation.unmapped = typeof summary.unmapped === "number" ? summary.unmapped : 0;
  return { byOperation, trimDeltaUs };
}

function omitTimelineData(timeline: HumanCorrectionSummaryTimeline): Omit<HumanCorrectionSummaryTimeline, "data"> {
  return { path: timeline.path, version: timeline.version, sha256: timeline.sha256 };
}

function emptyHumanCorrectionReasonCounts(): HumanCorrectionReasonCounts {
  return Object.fromEntries(HUMAN_CORRECTION_REASONS.map((reason) => [reason, 0])) as HumanCorrectionReasonCounts;
}

function emptyHumanCorrectionDomainCounts(): HumanCorrectionDomainCounts {
  return Object.fromEntries(HUMAN_CORRECTION_DOMAINS.map((domain) => [domain, 0])) as HumanCorrectionDomainCounts;
}

function emptyHumanCorrectionOperationCounts(): HumanCorrectionOperationCounts {
  return Object.fromEntries([
    ...HUMAN_REVISION_OPERATION_TYPES,
    "unmapped",
  ].map((operation) => [operation, 0])) as HumanCorrectionOperationCounts;
}

function isHumanCorrectionReason(value: unknown): value is HumanCorrectionReason {
  return typeof value === "string"
    && (HUMAN_CORRECTION_REASONS as readonly string[]).includes(value);
}

function isHumanCorrectionDomain(value: unknown): value is HumanCorrectionDomain {
  return typeof value === "string"
    && (HUMAN_CORRECTION_DOMAINS as readonly string[]).includes(value);
}

function isHumanRevisionOperationKey(value: unknown): value is typeof HUMAN_REVISION_OPERATION_TYPES[number] {
  return typeof value === "string"
    && (HUMAN_REVISION_OPERATION_TYPES as readonly string[]).includes(value);
}

function isCanonicalSha256(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}

function isSafeRelativeArtifactPath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\\")
    || value.startsWith("/") || value.includes("//")) return false;
  const parts = value.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) return false;
  return path.posix.normalize(value) === value;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

const EXPLICIT_CLIP_REFERENCE_PREFIXES = new Set([
  "asset",
  "clip",
  "exchange_clip",
  "exchange_clip_id",
  "operation",
  "segment",
  "timeline",
  "track",
]);

function referenceVariants(reference: string): string[] {
  const variants = new Set<string>();
  const pending = [reference.trim()];
  while (pending.length > 0 && variants.size < 16) {
    const current = pending.shift()!;
    if (!current || variants.has(current)) continue;
    variants.add(current);
    const separator = current.indexOf(":");
    if (separator >= 0 && EXPLICIT_CLIP_REFERENCE_PREFIXES.has(current.slice(0, separator))) {
      pending.push(current.slice(separator + 1));
    }
    const fragment = current.lastIndexOf("#");
    if (fragment >= 0 && fragment + 1 < current.length) pending.push(current.slice(fragment + 1));
  }
  return [...variants];
}

type StableClipIndex = Map<string, Set<string>>;

function buildStableClipIndex(timelines: TimelineDoc[]): StableClipIndex {
  const index: StableClipIndex = new Map();
  for (const timeline of timelines) {
    for (const clip of videoClips(timeline)) {
      const stableId = [clip.exchange_clip_id, clip.clip_id, clip.segment_id, clip.candidate_ref]
        .find((value): value is string => typeof value === "string" && value.trim().length > 0);
      if (!stableId) continue;
      const canonical = `clip:${stableId}`;
      const references = [clip.exchange_clip_id, clip.clip_id, clip.segment_id, clip.candidate_ref]
        .filter((value): value is string => typeof value === "string" && value.trim().length > 0);
      for (const reference of references) {
        for (const variant of referenceVariants(reference)) {
          const matches = index.get(variant) ?? new Set<string>();
          matches.add(canonical);
          index.set(variant, matches);
        }
      }
    }
  }
  return index;
}

function resolveStableClipRef(note: HumanCorrectionNote, index: StableClipIndex): string {
  const explicitReferences = [
    ...(note.clip_ids ?? []),
    ...(note.clip_refs ?? []),
    ...(note.approved_segment_ids ?? []),
  ].filter((reference): reference is string => typeof reference === "string" && reference.trim().length > 0);
  const matches = new Set<string>();
  for (const reference of explicitReferences) {
    for (const variant of referenceVariants(reference)) {
      for (const match of index.get(variant) ?? []) matches.add(match);
    }
  }
  return matches.size === 1 ? [...matches][0]! : "unknown";
}

function derivePostExportEditDistance(diff: { relativePath: string; data: HumanRevisionDiffDoc } | null): ProductMetric {
  if (!diff) {
    return unavailableMetric(
      "operations",
      "canonical_human_revision_diff",
      [],
      "No canonical human_revision_diff.yaml exists; dry-run exports are not treated as observed NLE edits.",
    );
  }
  const byKind: Record<string, number> = {};
  for (const [kind, count] of Object.entries(diff.data.summary ?? {})) {
    if (typeof count === "number") byKind[kind] = count;
  }
  const operations = diff.data.operations ?? [];
  const operationCount = Object.entries(byKind)
    .filter(([kind]) => kind !== "unmapped")
    .reduce((sum, [, count]) => sum + count, 0);
  const unmappedCount = byKind.unmapped ?? diff.data.unmapped_edits?.length ?? 0;
  const trimDeltaUs = operations.reduce((sum, operation) =>
    sum + Math.abs(operation.delta?.in_us ?? 0) + Math.abs(operation.delta?.out_us ?? 0), 0);
  const changedClipCount = new Set(
    operations.map((operation) => operation.target?.exchange_clip_id).filter(Boolean),
  ).size;
  return {
    status: "measured",
    value: {
      operation_count: operationCount,
      unmapped_count: unmappedCount,
      changed_clip_count: changedClipCount,
      trim_delta_us: trimDeltaUs,
      by_kind: byKind,
    },
    unit: "operations",
    method: "canonical_human_revision_diff",
    numerator: operationCount + unmappedCount,
    evidence: [diff.relativePath],
    limitations: ["Operation counts are structural edit distance; aesthetic magnitude is not inferred."],
  };
}

function deriveReviewIssueDensity(
  review: LoadedArtifact<ReviewReportDoc> | null,
  durationSec: number,
): ProductMetric {
  if (!review || durationSec <= 0) {
    return unavailableMetric(
      "issues_per_minute",
      "review_negative_findings_per_timeline_minute",
      review ? [review.relativePath] : [],
      "A review report and non-zero timeline duration are required.",
    );
  }
  const byCategory = {
    weakness: review.data.weaknesses?.length ?? 0,
    fatal: review.data.fatal_issues?.length ?? 0,
    warning: review.data.warnings?.length ?? 0,
    brief_mismatch: review.data.mismatches_to_brief?.length ?? 0,
    blueprint_mismatch: review.data.mismatches_to_blueprint?.length ?? 0,
  };
  const totalIssues = Object.values(byCategory).reduce((sum, count) => sum + count, 0);
  const durationMinutes = durationSec / 60;
  return {
    status: "measured",
    value: {
      issues_per_minute: round(totalIssues / durationMinutes, 6),
      total_issues: totalIssues,
      duration_minutes: round(durationMinutes, 6),
      by_category: byCategory,
    },
    unit: "issues_per_minute",
    method: "review_negative_findings_per_timeline_minute",
    numerator: totalIssues,
    denominator: round(durationMinutes, 6),
    evidence: [review.relativePath],
    limitations: ["Counts explicit negative review findings; visual-QA gate state is reported separately as a degraded-run flag."],
  };
}

function deriveRerunDuration(
  timings: LoadedArtifact<PipelineTimingsDoc> | null,
  progress: LoadedArtifact<ProgressDoc> | null,
): ProductMetric {
  const completedRuns = (timings?.data.runs ?? [])
    .map((run) => ({ run, start: timestampMs(run.started_at), end: timestampMs(run.completed_at) }))
    .filter((item): item is { run: NonNullable<PipelineTimingsDoc["runs"]>[number]; start: number; end: number } =>
      item.run.status === "completed" && item.start !== null && item.end !== null && item.end >= item.start
    )
    .sort((a, b) => b.end - a.end);
  if (timings && completedRuns[0]) {
    return {
      status: "measured",
      value: round((completedRuns[0].end - completedRuns[0].start) / 1000, 3),
      unit: "seconds",
      method: "latest_completed_pipeline_timing_run",
      evidence: [timings.relativePath],
      limitations: [],
    };
  }
  const start = timestampMs(progress?.data.started_at);
  const end = timestampMs(progress?.data.updated_at);
  if (progress && progress.data.status === "completed" && start !== null && end !== null && end >= start) {
    return {
      status: "estimated",
      value: round((end - start) / 1000, 3),
      unit: "seconds",
      method: "latest_phase_progress_elapsed_proxy",
      evidence: [progress.relativePath],
      limitations: ["progress.json contains only the latest phase, so this is not a full pipeline rerun duration."],
    };
  }
  return unavailableMetric(
    "seconds",
    "latest_completed_pipeline_timing_run",
    [timings?.relativePath, progress?.relativePath].filter((item): item is string => Boolean(item)),
    "No completed pipeline timing run or completed progress interval is available.",
  );
}

function deriveDegradedFlags(
  state: LoadedArtifact<ProjectStateDoc> | null,
  review: LoadedArtifact<ReviewReportDoc> | null,
  progress: LoadedArtifact<ProgressDoc> | null,
  timings: LoadedArtifact<PipelineTimingsDoc> | null,
): DegradedRunFlag[] {
  const flags: DegradedRunFlag[] = [];
  if (state && (state.data.analysis_override?.status === "active" || state.data.gates?.analysis_gate === "partial_override")) {
    flags.push({
      code: "analysis_partial_override",
      severity: "warning",
      message: state.data.analysis_override?.reason ?? "Analysis gate is operating under an active partial override.",
      evidence: [state.relativePath],
    });
  }
  if (review?.data.visual_qa?.status && review.data.visual_qa.status !== "verified") {
    const waived = review.data.visual_qa_waiver === true;
    flags.push({
      code: waived ? "visual_qa_waived" : "visual_qa_not_verified",
      severity: waived ? "warning" : "blocker",
      message: review.data.visual_qa_waiver_reason ?? review.data.visual_qa.reason ?? `Visual QA status is ${review.data.visual_qa.status}.`,
      evidence: [review.relativePath],
    });
  }
  if ((review?.data.fatal_issues?.length ?? 0) > 0) {
    flags.push({
      code: "fatal_review_issues",
      severity: "blocker",
      message: `${review?.data.fatal_issues?.length ?? 0} fatal review issue(s) remain.`,
      evidence: [review!.relativePath],
    });
  }
  if (progress && (progress.data.status === "failed" || progress.data.status === "blocked" || (progress.data.errors?.length ?? 0) > 0)) {
    flags.push({
      code: "latest_progress_degraded",
      severity: progress.data.status === "failed" || progress.data.status === "blocked" ? "blocker" : "warning",
      message: `Latest ${progress.data.phase ?? "pipeline"} progress is ${progress.data.status ?? "unknown"} with ${progress.data.errors?.length ?? 0} recorded error(s).`,
      evidence: [progress.relativePath],
    });
  }
  const latestRun = [...(timings?.data.runs ?? [])]
    .sort((a, b) => (timestampMs(b.started_at) ?? 0) - (timestampMs(a.started_at) ?? 0))[0];
  const skippedStages = latestRun?.stages?.filter((stage) => stage.status === "skipped") ?? [];
  const failedStages = latestRun?.stages?.filter((stage) => stage.status === "failed") ?? [];
  if (timings && (skippedStages.length > 0 || failedStages.length > 0)) {
    flags.push({
      code: "pipeline_stages_degraded",
      severity: failedStages.length > 0 ? "blocker" : "warning",
      message: `Latest timing run has ${failedStages.length} failed and ${skippedStages.length} skipped stage(s).`,
      evidence: [timings.relativePath],
    });
  }
  return flags;
}

function loadApprovedTimeline(
  projectDir: string,
  malformed: DegradedRunFlag[],
): LoadedArtifact<TimelineDoc> | null {
  const absolutePath = path.join(projectDir, APPROVED_TIMELINE_PATH);
  try {
    fs.lstatSync(absolutePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    malformed.push({
      code: "malformed_approved_timeline",
      severity: "warning",
      message: `${APPROVED_TIMELINE_PATH} could not be inspected: ${error instanceof Error ? error.message : String(error)}`,
      evidence: [APPROVED_TIMELINE_PATH],
    });
    return null;
  }
  const inspection = inspectImmutableRecordFile(absolutePath, projectDir);
  if (!inspection.ok) {
    malformed.push({
      code: "malformed_approved_timeline",
      severity: "warning",
      message: `${APPROVED_TIMELINE_PATH} failed immutable-file inspection: ${inspection.reason}`,
      evidence: [APPROVED_TIMELINE_PATH],
    });
    return null;
  }
  if (!inspection.document || typeof inspection.document !== "object" || Array.isArray(inspection.document)) {
    malformed.push({
      code: "malformed_approved_timeline",
      severity: "warning",
      message: `${APPROVED_TIMELINE_PATH} is not a timeline mapping`,
      evidence: [APPROVED_TIMELINE_PATH],
    });
    return null;
  }
  return {
    relativePath: APPROVED_TIMELINE_PATH,
    absolutePath,
    data: inspection.document as TimelineDoc,
    hashOverride: inspection.sha256,
  };
}

function loadHumanNotesYaml(
  projectDir: string,
  malformed: DegradedRunFlag[],
): LoadedArtifact<HumanNotesDoc> | null {
  const absolutePath = path.join(projectDir, HUMAN_NOTES_PATH);
  try {
    fs.lstatSync(absolutePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    malformed.push({
      code: "malformed_human_notes",
      severity: "warning",
      message: `${HUMAN_NOTES_PATH} could not be inspected: ${error instanceof Error ? error.message : String(error)}`,
      evidence: [HUMAN_NOTES_PATH],
    });
    return null;
  }
  const inspection = inspectImmutableYamlFile(projectDir, HUMAN_NOTES_PATH);
  if ("error" in inspection) {
    malformed.push({
      code: "malformed_human_notes",
      severity: "warning",
      message: `${HUMAN_NOTES_PATH} failed immutable-file inspection: ${inspection.error}`,
      evidence: [HUMAN_NOTES_PATH],
    });
    return null;
  }
  if (!inspection.document || typeof inspection.document !== "object" || Array.isArray(inspection.document)) {
    malformed.push({
      code: "malformed_human_notes",
      severity: "warning",
      message: `${HUMAN_NOTES_PATH} is not a human-notes mapping`,
      evidence: [HUMAN_NOTES_PATH],
    });
    return null;
  }
  const validation = validateAgainstSchema(inspection.document, "human-notes.schema.json");
  if (!validation.valid) {
    malformed.push({
      code: "malformed_human_notes",
      severity: "warning",
      message: `${HUMAN_NOTES_PATH} failed schema validation: ${validation.errors.slice(0, 2).join("; ")}`,
      evidence: [HUMAN_NOTES_PATH],
    });
    return null;
  }
  return {
    relativePath: HUMAN_NOTES_PATH,
    absolutePath,
    data: inspection.document as HumanNotesDoc,
    hashOverride: inspection.sha256,
  };
}

function unavailableMetric(unit: string, method: string, evidence: string[], limitation: string): ProductMetric {
  return {
    status: "unavailable",
    value: null,
    unit,
    method,
    evidence,
    limitations: [limitation],
  };
}

function clipsMatch(a: TimelineClip, b: TimelineClip): boolean {
  if (a.clip_id && b.clip_id && a.clip_id === b.clip_id) return true;
  if (a.candidate_ref && b.candidate_ref && a.candidate_ref === b.candidate_ref) return true;
  if (!a.asset_id || !b.asset_id || a.asset_id !== b.asset_id) return false;
  if (!a.segment_id || !b.segment_id || a.segment_id !== b.segment_id) return false;
  if (![a.src_in_us, a.src_out_us, b.src_in_us, b.src_out_us].every((value) => typeof value === "number")) return false;
  const overlap = Math.max(0, Math.min(a.src_out_us!, b.src_out_us!) - Math.max(a.src_in_us!, b.src_in_us!));
  const baselineDuration = Math.max(1, a.src_out_us! - a.src_in_us!);
  return overlap / baselineDuration >= 0.5;
}

function videoClips(timeline: TimelineDoc): TimelineClip[] {
  return (timeline.tracks?.video ?? []).flatMap((track) => track.clips ?? []);
}

function uniqueSorted(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))].sort((left, right) =>
    left.localeCompare(right, "en"));
}

function loadBaselineTimeline(projectDir: string, malformed: DegradedRunFlag[]): LoadedArtifact<TimelineDoc> | null {
  const timelineDir = path.join(projectDir, "05_timeline");
  if (!fs.existsSync(timelineDir)) return null;
  const names = fs.readdirSync(timelineDir)
    .filter((name) => /^v\d+\.timeline\.json$/i.test(name))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (names.length === 0) return null;
  return loadOptionalJson<TimelineDoc>(projectDir, path.join("05_timeline", names[0]), malformed);
}

function loadRequiredTimeline(projectDir: string, relativePath: string): LoadedArtifact<TimelineDoc> {
  const absolutePath = path.join(projectDir, relativePath);
  const inspection = inspectImmutableRecordFile(absolutePath, projectDir);
  if (!inspection.ok) {
    throw new Error(`Required artifact ${relativePath} failed immutable inspection: ${inspection.reason}`);
  }
  if (!inspection.document || typeof inspection.document !== "object" || Array.isArray(inspection.document)) {
    throw new Error(`Required artifact ${relativePath} is not a timeline mapping`);
  }
  return {
    relativePath,
    absolutePath,
    data: inspection.document as TimelineDoc,
    hashOverride: inspection.sha256,
  };
}

function verifyTimelineSnapshots(
  projectDir: string,
  baseTimeline: LoadedArtifact<TimelineDoc>,
  approvedTimeline: LoadedArtifact<TimelineDoc> | null,
): boolean {
  const verify = (artifact: LoadedArtifact<TimelineDoc>): boolean => {
    if (!artifact.hashOverride) return false;
    const inspection = inspectImmutableRecordFile(artifact.absolutePath, projectDir);
    return inspection.ok && inspection.sha256 === artifact.hashOverride;
  };
  return verify(baseTimeline) && (approvedTimeline === null || verify(approvedTimeline));
}

function loadRequiredJson<T>(projectDir: string, relativePath: string): LoadedArtifact<T> {
  const absolutePath = path.join(projectDir, relativePath);
  if (!fs.existsSync(absolutePath)) throw new Error(`Required artifact not found: ${relativePath}`);
  return { relativePath, absolutePath, data: JSON.parse(fs.readFileSync(absolutePath, "utf-8")) as T };
}

function loadOptionalJson<T>(
  projectDir: string,
  relativePath: string,
  malformed: DegradedRunFlag[],
): LoadedArtifact<T> | null {
  return loadOptional<T>(projectDir, relativePath, (raw) => JSON.parse(raw) as T, malformed);
}

function loadOptionalYaml<T>(
  projectDir: string,
  relativePath: string,
  malformed: DegradedRunFlag[],
): LoadedArtifact<T> | null {
  return loadOptional<T>(projectDir, relativePath, (raw) => parseYaml(raw) as T, malformed);
}

function loadOptional<T>(
  projectDir: string,
  relativePath: string,
  parse: (raw: string) => T,
  malformed: DegradedRunFlag[],
): LoadedArtifact<T> | null {
  const normalizedPath = relativePath.split(path.sep).join("/");
  const absolutePath = path.join(projectDir, relativePath);
  if (!fs.existsSync(absolutePath)) return null;
  try {
    return { relativePath: normalizedPath, absolutePath, data: parse(fs.readFileSync(absolutePath, "utf-8")) };
  } catch (error) {
    malformed.push({
      code: `malformed_${path.basename(relativePath).replace(/[^a-z0-9]+/gi, "_").toLowerCase()}`,
      severity: "warning",
      message: `${normalizedPath} could not be read: ${error instanceof Error ? error.message : String(error)}`,
      evidence: [normalizedPath],
    });
    return null;
  }
}

function existingPaths(projectDir: string, paths: Array<string | undefined>): string[] {
  return [...new Set(paths.filter((item): item is string => Boolean(item)))]
    .filter((relativePath) => fs.existsSync(path.join(projectDir, relativePath)))
    .sort();
}

function uniqueArtifacts(artifacts: Array<LoadedArtifact<unknown> | null>): Array<LoadedArtifact<unknown>> {
  const byPath = new Map<string, LoadedArtifact<unknown>>();
  for (const artifact of artifacts) {
    if (!artifact) continue;
    const previous = byPath.get(artifact.relativePath);
    if (!previous) {
      byPath.set(artifact.relativePath, artifact);
      continue;
    }
    // A path may be contributed by more than one evidence role. Preserve the
    // immutable hash captured by the strongest consumer instead of allowing a
    // later path-only entry to trigger a fresh read of another generation.
    byPath.set(artifact.relativePath, {
      ...previous,
      ...artifact,
      hashOverride: artifact.hashOverride ?? previous.hashOverride,
    });
  }
  return [...byPath.values()].sort((left, right) => left.relativePath.localeCompare(right.relativePath, "en"));
}

function timestampMs(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function sha256File(filePath: string): string {
  return `sha256:${crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex")}`;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
