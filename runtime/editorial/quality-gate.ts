import type {
  Candidate,
  CreativeBrief,
  QualityConfidence,
  QualityGateDecision,
  QualityGateMeasurements,
  QualityGateRecord,
  QualityGateThresholds,
  SelectsCandidates,
  SelectsQualityGateSummary,
} from "../artifacts/types.js";
import type { VisualQualityMeasurements } from "../connectors/ffmpeg-motion.js";
import { loadDefaults, resolvePolicy } from "../policy-resolver.js";
import { isAudioOnlyCandidate } from "../artifacts/source-media-capabilities.js";

export const QUALITY_GATE_POLICY_NAME = "analysis-defaults.quality_gate";

export const DEFAULT_QUALITY_GATE_THRESHOLDS: QualityGateThresholds = {
  shake_reject_above: 0.45,
  shake_warn_above: 0.35,
  sharpness_reject_below: 0.2,
  sharpness_warn_below: 0.35,
  exposure_crush_reject_above: 0.8,
  exposure_crush_warn_above: 0.3,
  exposure_clip_reject_above: 0.8,
  exposure_clip_warn_above: 0.3,
  appraiser_composition_reject_below: 0.2,
  appraiser_subject_prominence_reject_below: 0.2,
  appraiser_composition_warn_below: 0.35,
  appraiser_subject_prominence_warn_below: 0.35,
};

const REJECT_QUALITY_FLAGS = new Set(["black_segment", "frozen_frame"]);
const WARN_QUALITY_FLAGS = new Set(["shaky", "blur", "underexposed", "overexposed"]);

export interface QualityGateSegment {
  segment_id: string;
  asset_id?: string;
  summary?: string;
  transcript_excerpt?: string;
  tags?: string[];
  quality_flags?: string[];
  visual_quality_measurements?: VisualQualityMeasurements;
  visual_quality?: {
    scores?: {
      composition_score?: number;
      subject_prominence?: number;
    };
  };
  visual_appraisal?: {
    status?: string;
    skipped_reason?: string;
  };
}

export interface ApplyQualityGateOptions {
  brief?: CreativeBrief;
  thresholds?: Partial<QualityGateThresholds>;
  policyName?: string;
}

interface Issue {
  severity: "reject" | "warn";
  reason: string;
}

interface EvaluationContext {
  candidate: Candidate;
  segment?: QualityGateSegment;
  thresholds: QualityGateThresholds;
  briefMustHaves: string[];
  clusterCounts: Map<string, number>;
}

export function loadQualityGateConfig(projectDir?: string): {
  thresholds: QualityGateThresholds;
  policyName: string;
} {
  try {
    const policy = projectDir ? resolvePolicy(projectDir).resolved : loadDefaults();
    const policyName = stringValue(policy.policy_name) ?? "analysis-defaults";
    return {
      thresholds: qualityGateThresholdsFromPolicy(policy),
      policyName: `${policyName}.quality_gate`,
    };
  } catch {
    return {
      thresholds: { ...DEFAULT_QUALITY_GATE_THRESHOLDS },
      policyName: QUALITY_GATE_POLICY_NAME,
    };
  }
}

export function qualityGateThresholdsFromPolicy(policy: Record<string, unknown> | undefined): QualityGateThresholds {
  const raw = isRecord(policy?.quality_gate) ? policy.quality_gate : {};
  return normalizeThresholds(raw);
}

export function normalizeQualityGateThresholds(
  thresholds: Partial<QualityGateThresholds> | undefined,
): QualityGateThresholds {
  return normalizeThresholds(thresholds ?? {});
}

export function applyQualityGateToSelects(
  selects: SelectsCandidates,
  segments: QualityGateSegment[],
  options: ApplyQualityGateOptions = {},
): SelectsCandidates {
  const thresholds = normalizeQualityGateThresholds(options.thresholds);
  const segmentById = new Map(segments.map((segment) => [segment.segment_id, segment]));
  const clusterCounts = buildClusterCounts(selects.candidates, segmentById);
  const briefMustHaves = briefMustHaveStrings(options.brief);

  const candidates = selects.candidates.map((candidate) => {
    const segment = segmentById.get(candidate.segment_id);
    const record = evaluateQualityGate({
      candidate,
      segment,
      thresholds,
      briefMustHaves,
      clusterCounts,
    });
    return attachQualityGate(candidate, record);
  });

  const decisions = candidates
    .map((candidate) => candidate.quality_gate)
    .filter((record): record is QualityGateRecord => Boolean(record));
  const qualityGate: SelectsQualityGateSummary = {
    version: "1",
    policy: options.policyName ?? QUALITY_GATE_POLICY_NAME,
    counts: countDecisions(decisions),
    decisions,
  };

  return {
    ...selects,
    candidates,
    quality_gate: qualityGate,
  };
}

export function evaluateQualityGate(ctx: EvaluationContext): QualityGateRecord {
  if (isAudioOnlyCandidate(ctx.candidate)) {
    return {
      ...(ctx.candidate.candidate_id ? { candidate_id: ctx.candidate.candidate_id } : {}),
      segment_id: ctx.candidate.segment_id,
      decision: "not_applicable",
      confidence: "not_applicable",
      reasons: ["visual_quality_not_applicable_audio_only"],
      measurements: {},
      thresholds: ctx.thresholds,
    };
  }
  const measurement = ctx.segment?.visual_quality_measurements;
  const measurements = collectMeasurements(ctx.segment);
  const issues = collectIssues(ctx, measurements);
  const hasMeasuredMetric = hasVisualQualityMetric(measurement);
  const hasFullMeasurements = measurement?.measured === true;
  const hasAppraiserScores = hasAppraiserMeasurements(measurements);
  const confidence = qualityConfidence({ hasMeasuredMetric, hasFullMeasurements, hasAppraiserScores });

  if (measurement && hasMeasuredMetric && !hasFullMeasurements) {
    issues.push({ severity: "warn", reason: "partial_visual_quality_measurements" });
  }

  let decision: QualityGateDecision;
  if (!hasMeasuredMetric && !hasAppraiserScores && issues.length === 0) {
    decision = "unmeasured";
    issues.push({
      severity: "warn",
      reason: measurement?.failure_reason
        ? `visual_quality_unmeasured:${shortReason(measurement.failure_reason)}`
        : "visual_quality_unmeasured",
    });
  } else if (issues.some((issue) => issue.severity === "reject")) {
    decision = "reject";
  } else if (issues.some((issue) => issue.severity === "warn")) {
    decision = "warn";
  } else {
    decision = "pass";
    issues.push({ severity: "warn", reason: "quality_gate_pass" });
  }

  const protectedBy = decision === "reject" ? recallProtections(ctx) : [];
  if (decision === "reject" && protectedBy.length > 0) {
    decision = "warn";
    issues.push({ severity: "warn", reason: "reject_downgraded_for_recall_protection" });
  }

  return {
    ...(ctx.candidate.candidate_id ? { candidate_id: ctx.candidate.candidate_id } : {}),
    segment_id: ctx.candidate.segment_id,
    decision,
    confidence,
    reasons: uniqueStrings(issues.map((issue) => issue.reason)),
    measurements,
    thresholds: ctx.thresholds,
    ...(protectedBy.length > 0 ? { protected_by: protectedBy } : {}),
  };
}

function collectIssues(ctx: EvaluationContext, measurements: QualityGateMeasurements): Issue[] {
  const issues: Issue[] = [];
  const t = ctx.thresholds;

  if (isScore(measurements.shake_score)) {
    if (measurements.shake_score > t.shake_reject_above) {
      issues.push({ severity: "reject", reason: "shake_score_above_reject" });
    } else if (measurements.shake_score >= t.shake_warn_above) {
      issues.push({ severity: "warn", reason: "shake_score_above_warn" });
    }
  }

  if (isScore(measurements.sharpness_score)) {
    if (measurements.sharpness_score < t.sharpness_reject_below) {
      issues.push({ severity: "reject", reason: "sharpness_score_below_reject" });
    } else if (measurements.sharpness_score <= t.sharpness_warn_below) {
      issues.push({ severity: "warn", reason: "sharpness_score_below_warn" });
    }
  }

  if (isScore(measurements.black_clip_ratio)) {
    if (measurements.black_clip_ratio > t.exposure_crush_reject_above) {
      issues.push({ severity: "reject", reason: "black_clip_ratio_above_reject" });
    } else if (measurements.black_clip_ratio >= t.exposure_crush_warn_above) {
      issues.push({ severity: "warn", reason: "black_clip_ratio_above_warn" });
    }
  }

  if (isScore(measurements.white_clip_ratio)) {
    if (measurements.white_clip_ratio > t.exposure_clip_reject_above) {
      issues.push({ severity: "reject", reason: "white_clip_ratio_above_reject" });
    } else if (measurements.white_clip_ratio >= t.exposure_clip_warn_above) {
      issues.push({ severity: "warn", reason: "white_clip_ratio_above_warn" });
    }
  }

  if (isScore(measurements.composition_score) && isScore(measurements.subject_prominence)) {
    if (
      measurements.composition_score < t.appraiser_composition_reject_below &&
      measurements.subject_prominence < t.appraiser_subject_prominence_reject_below
    ) {
      issues.push({ severity: "reject", reason: "appraiser_composition_and_subject_below_reject" });
    } else if (
      measurements.composition_score < t.appraiser_composition_warn_below ||
      measurements.subject_prominence < t.appraiser_subject_prominence_warn_below
    ) {
      issues.push({ severity: "warn", reason: "appraiser_composition_or_subject_below_warn" });
    }
  }

  for (const flag of qualityFlags(ctx.candidate, ctx.segment)) {
    if (REJECT_QUALITY_FLAGS.has(flag)) {
      issues.push({ severity: "reject", reason: `quality_flag_${flag}` });
    } else if (WARN_QUALITY_FLAGS.has(flag)) {
      issues.push({ severity: "warn", reason: `quality_flag_${flag}` });
    }
  }

  return issues;
}

function attachQualityGate(candidate: Candidate, record: QualityGateRecord): Candidate {
  const next: Candidate = {
    ...candidate,
    risks: [...candidate.risks],
    quality_gate: record,
    quality_confidence: record.confidence,
  };

  if (candidate.quality_flags) next.quality_flags = [...candidate.quality_flags];
  if (candidate.evidence) next.evidence = [...candidate.evidence];
  if (candidate.eligible_beats) next.eligible_beats = [...candidate.eligible_beats];
  if (candidate.motif_tags) next.motif_tags = [...candidate.motif_tags];
  if (candidate.utterance_ids) next.utterance_ids = [...candidate.utterance_ids];
  if (candidate.editorial_signals) {
    next.editorial_signals = {
      ...candidate.editorial_signals,
      ...(candidate.editorial_signals.visual_tags
        ? { visual_tags: [...candidate.editorial_signals.visual_tags] }
        : {}),
    };
  }
  if (candidate.peak_signals) {
    next.peak_signals = {
      ...candidate.peak_signals,
      ...(candidate.peak_signals.speech_keyword ? { speech_keyword: [...candidate.peak_signals.speech_keyword] } : {}),
    };
  }
  if (candidate.trim_hint) next.trim_hint = { ...candidate.trim_hint };

  next.quality_flags = uniqueStrings([
    ...(next.quality_flags ?? []),
    ...qualityGateFlags(record),
  ]);

  if (record.decision === "reject" && next.role !== "reject") {
    next.role = "reject";
    next.rejection_reason = `auto-rejected: ${record.reasons.join(", ")}`;
  } else if (candidate.rejection_reason) {
    next.rejection_reason = candidate.rejection_reason;
  }

  return next;
}

function qualityGateFlags(record: QualityGateRecord): string[] {
  if (record.decision === "not_applicable") return [];
  if (record.decision === "reject") return ["quality_gate_reject"];
  if (record.decision === "warn") return ["quality_gate_warn"];
  if (record.decision === "unmeasured") return ["quality_gate_unmeasured", "quality_confidence_low"];
  if (record.confidence === "low") return ["quality_confidence_low"];
  if (record.confidence === "partial") return ["quality_measurement_partial"];
  return [];
}

function collectMeasurements(segment: QualityGateSegment | undefined): QualityGateMeasurements {
  const measurement = segment?.visual_quality_measurements;
  const scores = segment?.visual_appraisal?.status === "skipped"
    ? undefined
    : segment?.visual_quality?.scores;
  const result: QualityGateMeasurements = {};

  if (isScore(measurement?.shake?.score)) result.shake_score = round3(measurement.shake.score);
  if (isScore(measurement?.sharpness?.sharpness_score)) {
    result.sharpness_score = round3(measurement.sharpness.sharpness_score);
  }
  if (isScore(measurement?.exposure?.exposure_score)) {
    result.exposure_score = round3(measurement.exposure.exposure_score);
  }
  if (isScore(measurement?.exposure?.black_clip_ratio)) {
    result.black_clip_ratio = round3(measurement.exposure.black_clip_ratio);
  }
  if (isScore(measurement?.exposure?.white_clip_ratio)) {
    result.white_clip_ratio = round3(measurement.exposure.white_clip_ratio);
  }
  if (isScore(scores?.composition_score)) result.composition_score = round3(scores.composition_score);
  if (isScore(scores?.subject_prominence)) result.subject_prominence = round3(scores.subject_prominence);

  return result;
}

function hasVisualQualityMetric(measurement: VisualQualityMeasurements | undefined): boolean {
  if (!measurement) return false;
  return Boolean(
    measurement.metrics_measured.shake ||
    measurement.metrics_measured.sharpness ||
    measurement.metrics_measured.exposure,
  );
}

function hasAppraiserMeasurements(measurements: QualityGateMeasurements): boolean {
  return isScore(measurements.composition_score) && isScore(measurements.subject_prominence);
}

function qualityConfidence(input: {
  hasMeasuredMetric: boolean;
  hasFullMeasurements: boolean;
  hasAppraiserScores: boolean;
}): QualityConfidence {
  if (input.hasFullMeasurements) return "measured";
  if (input.hasMeasuredMetric) return "partial";
  if (input.hasAppraiserScores) return "appraiser";
  return "low";
}

function recallProtections(ctx: EvaluationContext): string[] {
  const protectedBy: string[] = [];
  if (ctx.candidate.role === "hero") protectedBy.push("hero_role");
  if (mustHaveMatches(ctx.candidate, ctx.segment, ctx.briefMustHaves).length > 0) {
    protectedBy.push("brief_must_have_match");
  }
  const clusterId = candidateClusterId(ctx.candidate);
  if (clusterId && ctx.clusterCounts.get(clusterId) === 1) {
    protectedBy.push(`unique_cluster:${clusterId}`);
  }
  return protectedBy;
}

export function mustHaveMatches(
  candidate: Candidate,
  segment: QualityGateSegment | undefined,
  mustHaves: string[],
): string[] {
  if (mustHaves.length === 0) return [];
  const haystack = normalizeSearchText([
    candidate.why_it_matches,
    ...(candidate.evidence ?? []),
    ...(candidate.eligible_beats ?? []),
    ...(candidate.motif_tags ?? []),
    ...(candidate.editorial_signals?.visual_tags ?? []),
    segment?.summary,
    segment?.transcript_excerpt,
    ...(segment?.tags ?? []),
  ]);
  return mustHaves.filter((item) => {
    const needle = normalizeSearchText([item]);
    return needle.length > 0 && haystack.includes(needle);
  });
}

function buildClusterCounts(
  candidates: Candidate[],
  segmentById: Map<string, QualityGateSegment>,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const candidate of candidates) {
    if (candidate.role === "reject") continue;
    const segment = segmentById.get(candidate.segment_id);
    const clusterId = candidateClusterId(candidate) ?? segmentClusterId(segment);
    if (!clusterId) continue;
    counts.set(clusterId, (counts.get(clusterId) ?? 0) + 1);
  }
  return counts;
}

function candidateClusterId(candidate: Candidate): string | undefined {
  return stringValue(candidate.editorial_signals?.semantic_cluster_id);
}

function segmentClusterId(segment: QualityGateSegment | undefined): string | undefined {
  const tags = (segment?.tags ?? []).map(normalizeTag).filter((tag) => tag.length > 0);
  if (tags.length === 0) return undefined;
  return tags.slice(0, 2).join("_");
}

function qualityFlags(candidate: Candidate, segment: QualityGateSegment | undefined): string[] {
  return uniqueStrings([...(candidate.quality_flags ?? []), ...(segment?.quality_flags ?? [])]
    .map(normalizeTag)
    .filter((flag) => flag.length > 0));
}

function countDecisions(records: QualityGateRecord[]): SelectsQualityGateSummary["counts"] {
  const counts: SelectsQualityGateSummary["counts"] = { reject: 0, warn: 0, pass: 0, unmeasured: 0 };
  let notApplicable = 0;
  for (const record of records) {
    if (record.decision === "not_applicable") notApplicable += 1;
    else counts[record.decision] += 1;
  }
  if (notApplicable > 0) counts.not_applicable = notApplicable;
  return counts;
}

function normalizeThresholds(raw: Partial<QualityGateThresholds> | Record<string, unknown>): QualityGateThresholds {
  return {
    shake_reject_above: threshold(raw, "shake_reject_above"),
    shake_warn_above: threshold(raw, "shake_warn_above"),
    sharpness_reject_below: threshold(raw, "sharpness_reject_below"),
    sharpness_warn_below: threshold(raw, "sharpness_warn_below"),
    exposure_crush_reject_above: threshold(raw, "exposure_crush_reject_above"),
    exposure_crush_warn_above: threshold(raw, "exposure_crush_warn_above"),
    exposure_clip_reject_above: threshold(raw, "exposure_clip_reject_above"),
    exposure_clip_warn_above: threshold(raw, "exposure_clip_warn_above"),
    appraiser_composition_reject_below: threshold(raw, "appraiser_composition_reject_below"),
    appraiser_subject_prominence_reject_below: threshold(raw, "appraiser_subject_prominence_reject_below"),
    appraiser_composition_warn_below: threshold(raw, "appraiser_composition_warn_below"),
    appraiser_subject_prominence_warn_below: threshold(raw, "appraiser_subject_prominence_warn_below"),
  };
}

function threshold<K extends keyof QualityGateThresholds>(
  raw: Partial<QualityGateThresholds> | Record<string, unknown>,
  key: K,
): number {
  const value = (raw as Partial<QualityGateThresholds>)[key];
  return isScore(value) ? value : DEFAULT_QUALITY_GATE_THRESHOLDS[key];
}

function briefMustHaveStrings(brief: CreativeBrief | undefined): string[] {
  const value = (brief as Record<string, unknown> | undefined)?.must_have;
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item.length > 0);
}

function normalizeSearchText(values: Array<string | undefined>): string {
  return values
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join(" ")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeTag(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_:-]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function isScore(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function shortReason(reason: string): string {
  return reason.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 48) || "unknown";
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
