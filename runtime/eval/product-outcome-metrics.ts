import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { validateAgainstSchema } from "../commands/shared.js";
import { computeNormalizedJsonHash } from "../artifacts/p1-manifest-coverage.js";

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
  version: "1.0.0";
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

interface DegradedRunFlag {
  code: string;
  severity: "info" | "warning" | "blocker";
  message: string;
  evidence: string[];
}

interface TimelineClip {
  clip_id?: string;
  segment_id?: string;
  asset_id?: string;
  src_in_us?: number;
  src_out_us?: number;
  timeline_in_frame?: number;
  timeline_duration_frames?: number;
  candidate_ref?: string;
}

interface TimelineDoc {
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
  approval_record?: { approved_at?: string; approved_by?: string };
  analysis_override?: { status?: string; reason?: string };
  gates?: { analysis_gate?: string };
}

interface HumanNotesDoc {
  notes?: Array<{
    timestamp?: string;
    reviewer?: string;
    directive_type?: string;
    clip_ids?: string[];
    clip_refs?: string[];
    approved_segment_ids?: string[];
  }>;
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
    type?: string;
    target?: { exchange_clip_id?: string };
    delta?: { in_us?: number; out_us?: number; duration_frames?: number };
  }>;
  unmapped_edits?: unknown[];
}

interface LoadedArtifact<T> {
  relativePath: string;
  absolutePath: string;
  data: T;
}

const TIMELINE_PATH = "05_timeline/timeline.json";
const OUTPUT_PATH = "08_eval/product_outcome_metrics.json";

export function computeProductOutcomeMetricsHash(report: unknown): string {
  return computeNormalizedJsonHash(report, ["created_at", "report_id"]);
}

export function buildProductOutcomeMetrics(
  projectDirInput: string,
  createdAt = new Date().toISOString(),
): ProductOutcomeMetrics {
  const projectDir = path.resolve(projectDirInput);
  const malformed: DegradedRunFlag[] = [];
  const timeline = loadRequiredJson<TimelineDoc>(projectDir, TIMELINE_PATH);
  const state = loadOptionalYaml<ProjectStateDoc>(projectDir, "project_state.yaml", malformed);
  const humanNotes = loadOptionalYaml<HumanNotesDoc>(projectDir, "06_review/human_notes.yaml", malformed);
  const reviewReport = loadOptionalYaml<ReviewReportDoc>(projectDir, "06_review/review_report.yaml", malformed);
  const reviewPatch = loadOptionalJson<Record<string, unknown>>(projectDir, "06_review/review_patch.json", malformed);
  const reviewMetrics = loadOptionalJson<Record<string, unknown>>(projectDir, "06_review/review_metrics.json", malformed);
  const progress = loadOptionalJson<ProgressDoc>(projectDir, "progress.json", malformed);
  const pipelineTimings = loadOptionalJson<PipelineTimingsDoc>(projectDir, "03_analysis/pipeline-timings.json", malformed);
  const baseline = loadBaselineTimeline(projectDir, malformed);
  const revisionDiff = loadLatestNamedYaml<HumanRevisionDiffDoc>(projectDir, "human_revision_diff.yaml", malformed);

  const fps = timeline.data.sequence?.fps_num && timeline.data.sequence?.fps_den
    ? timeline.data.sequence.fps_num / timeline.data.sequence.fps_den
    : 0;
  const currentClips = videoClips(timeline.data);
  const durationFrames = currentClips.reduce(
    (max, clip) => Math.max(max, (clip.timeline_in_frame ?? 0) + (clip.timeline_duration_frames ?? 0)),
    0,
  );
  const durationSec = fps > 0 ? round(durationFrames / fps, 3) : 0;

  const timeToFirstUsableCut = deriveTimeToFirstUsableCut(state);
  const humanIntervention = deriveHumanInterventionMinutes(state, humanNotes);
  const keptCutRatio = deriveKeptCutRatio(baseline, timeline);
  const acceptedProposalRatio = deriveAcceptedProposalRatio(humanNotes, timeline, reviewPatch);
  const postExportEditDistance = derivePostExportEditDistance(revisionDiff);
  const reviewIssueDensity = deriveReviewIssueDensity(reviewReport, durationSec);
  const rerunDuration = deriveRerunDuration(pipelineTimings, progress);
  const rerunCost = unavailableMetric(
    "currency",
    "provider_cost_artifact",
    [],
    "No canonical provider-cost artifact is available; cost is not inferred from duration or model names.",
  );

  const degradedRunFlags = [
    ...deriveDegradedFlags(state, reviewReport, progress, pipelineTimings),
    ...malformed,
  ].sort((a, b) => a.code.localeCompare(b.code));

  const inputArtifacts = uniqueArtifacts([
    timeline,
    state,
    humanNotes,
    reviewReport,
    reviewPatch,
    reviewMetrics,
    progress,
    pipelineTimings,
    baseline,
    revisionDiff,
  ]);
  const requiredPaths = new Set([TIMELINE_PATH]);
  const evidenceRoles = {
    maker: existingPaths(projectDir, [TIMELINE_PATH, "04_plan/selects_candidates.yaml", "04_plan/edit_blueprint.yaml"]),
    deterministic_validator: existingPaths(projectDir, [
      "06_review/review_metrics.json",
      "progress.json",
      "03_analysis/pipeline-timings.json",
      revisionDiff?.relativePath,
    ]),
    checker: existingPaths(projectDir, ["06_review/review_report.yaml"]),
    human_preference: existingPaths(projectDir, ["06_review/human_notes.yaml", "project_state.yaml"]),
  };

  const report: ProductOutcomeMetrics = {
    version: "1.0.0",
    artifact_version: "product-outcome-metrics-v1",
    project_id: timeline.data.project_id ?? state?.data.project_id ?? path.basename(projectDir),
    created_at: createdAt,
    report_id: "POM_0000000000000000",
    timeline: {
      path: TIMELINE_PATH,
      version: String(timeline.data.version ?? "unknown"),
      hash: sha256File(timeline.absolutePath),
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
    },
    degraded_run_flags: degradedRunFlags,
    evidence_roles: evidenceRoles,
    provenance: {
      producer: "scripts/product-outcome-metrics.ts",
      inputs: inputArtifacts
        .map((artifact) => ({
          path: artifact.relativePath,
          hash: sha256File(artifact.absolutePath),
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

function derivePostExportEditDistance(diff: LoadedArtifact<HumanRevisionDiffDoc> | null): ProductMetric {
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

function loadBaselineTimeline(projectDir: string, malformed: DegradedRunFlag[]): LoadedArtifact<TimelineDoc> | null {
  const timelineDir = path.join(projectDir, "05_timeline");
  if (!fs.existsSync(timelineDir)) return null;
  const names = fs.readdirSync(timelineDir)
    .filter((name) => /^v\d+\.timeline\.json$/i.test(name))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (names.length === 0) return null;
  return loadOptionalJson<TimelineDoc>(projectDir, path.join("05_timeline", names[0]), malformed);
}

function loadLatestNamedYaml<T>(
  projectDir: string,
  fileName: string,
  malformed: DegradedRunFlag[],
): LoadedArtifact<T> | null {
  const matches: string[] = [];
  for (const searchRoot of ["exports/handoffs", "07_handoff"]) {
    const absoluteRoot = path.join(projectDir, searchRoot);
    if (!fs.existsSync(absoluteRoot)) continue;
    walkProject(absoluteRoot, (absolutePath) => {
      if (path.basename(absolutePath) === fileName) matches.push(absolutePath);
    });
  }
  const latest = matches.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
  if (!latest) return null;
  return loadOptionalYaml<T>(projectDir, path.relative(projectDir, latest), malformed);
}

function walkProject(directory: string, visit: (filePath: string) => void): void {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) walkProject(entryPath, visit);
    else if (entry.isFile()) visit(entryPath);
  }
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
    if (artifact) byPath.set(artifact.relativePath, artifact);
  }
  return [...byPath.values()];
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
