import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { CreativeBrief } from "../artifacts/types.js";
import type { TimelineIR } from "../compiler/types.js";
import {
  extractDurationUs,
  runFfprobe,
} from "../connectors/ffprobe.js";
import {
  assembleTimelineToMp4,
  type AssemblerOptions,
} from "../render/assembler.js";
import {
  assessRenderArtifactFreshness,
  createSourceInputAttestation,
  writeRenderFreshnessMetadata,
} from "../render/source-input-attestation.js";
import {
  DEGRADED_CONFIDENCE_CEILING,
  HIGH_CONFIDENCE_THRESHOLD,
  type ConfidenceBasis,
} from "../eval/brief-alignment-types.js";

export const WHOLE_CUT_SEMANTIC_VERSION = "1" as const;
export const DEFAULT_WHOLE_CUT_RENDER_PATH = "09_output/rough-cut.mp4";
export const DEFAULT_WHOLE_CUT_WINDOW_SEC = 30;
export const DEFAULT_WHOLE_CUT_OVERLAP_SEC = 3;
export const DEFAULT_WHOLE_CUT_PROVIDER_TIMEOUT_MS = 120_000;
const COVERAGE_EPSILON_SEC = 0.05;

export type WholeCutSemanticStatus = "verified" | "degraded" | "blocked" | "unavailable";
export type WholeCutProviderCapability = "available" | "degraded" | "unavailable_optional" | "failed";
export type WholeCutSemanticOutcome = "pass" | "needs_revision" | "blocked" | "unmeasured";
export type WholeCutAxisOutcome =
  | "pass"
  | "problem"
  | "uncertain"
  | "intentional_contrast"
  | "intentional_non_linear";
const WHOLE_CUT_AXIS_OUTCOMES = new Set<string>([
  "pass",
  "problem",
  "uncertain",
  "intentional_contrast",
  "intentional_non_linear",
]);

export type WholeCutSemanticAxisId =
  | "protagonist_story_identity"
  | "cause_action_progression"
  | "semantic_agreement_or_intended_contrast"
  | "information_emotion_situation_progression"
  | "cut_density_vs_story_progression"
  | "role_time_context"
  | "intentional_ambiguity_vs_missing_explanation"
  | "central_message_retention"
  | (string & {});

export interface WholeCutSemanticAxis {
  axis_id: WholeCutSemanticAxisId;
  label: string;
  source: "minimum" | "brief";
  minimum: boolean;
  rationale: string;
  brief_refs: string[];
}

export interface WholeCutRenderEvidence {
  path: string;
  sha256?: string;
  duration_sec: number;
}

export interface WholeCutTimelineIdentity {
  path: string;
  version: string;
  sha256?: string;
}

export interface WholeCutBriefIdentity {
  path: string;
  project_id: string;
  sha256?: string;
  axes: WholeCutSemanticAxis[];
}

export interface WholeCutCoverage {
  status: "complete" | "partial" | "missing";
  expected_duration_sec: number;
  covered_duration_sec: number;
  intervals: Array<{ start_sec: number; end_sec: number }>;
  uncovered_ranges: Array<{ start_sec: number; end_sec: number }>;
}

export interface WholeCutProviderRecord {
  provider_id: string;
  capability: WholeCutProviderCapability;
  model?: string;
  window_duration_sec: number;
  overlap_sec: number;
  window_count: number;
  completed_window_count: number;
  degradation_reasons: string[];
}

export interface WholeCutRenderRangeEvidence {
  path: string;
  start_sec: number;
  end_sec: number;
  sha256: string;
}

export interface WholeCutSourceEvidence {
  timeline_path: string;
  timeline_version: string;
  timeline_sha256: string;
  clip_id: string;
  asset_id: string;
  track_kind: "video" | "audio";
  timeline_start_sec: number;
  timeline_end_sec: number;
  source_range_us: { in_us: number; out_us: number };
}

export interface WholeCutObservationEvidence {
  render: WholeCutRenderRangeEvidence;
  source: WholeCutSourceEvidence[];
}

export interface WholeCutProgressionEvidence {
  score: number;
  confidence: number;
  confidence_basis: ConfidenceBasis;
}

export interface WholeCutObservation {
  observation_id: string;
  start_sec: number;
  end_sec: number;
  observation: string;
  inference: string;
  evidence: WholeCutObservationEvidence;
  confidence: number;
  confidence_basis: ConfidenceBasis;
  axis_ids: string[];
  story_progression?: WholeCutProgressionEvidence;
}

export interface WholeCutAxisCoverage {
  status: "complete" | "partial" | "missing";
  expected_duration_sec: number;
  covered_duration_sec: number;
  intervals: Array<{ start_sec: number; end_sec: number }>;
  uncovered_ranges: Array<{ start_sec: number; end_sec: number }>;
}

export interface WholeCutAxisResult {
  axis_id: string;
  outcome: WholeCutAxisOutcome;
  confidence: number;
  confidence_basis: ConfidenceBasis;
  brief_refs: string[];
  observation_ids: string[];
  coverage: WholeCutAxisCoverage;
  rationale: string;
}

export interface WholeCutUncertainty {
  description: string;
  impact: "high" | "low";
  clarification_question: {
    question: string;
    observation: string;
    hypothesis: string;
  };
}

export interface WholeCutProblemRange {
  problem_id: string;
  axis_id: string;
  start_sec: number;
  end_sec: number;
  summary: string;
  observation_ids: string[];
  render_evidence: WholeCutRenderRangeEvidence;
  source_evidence: WholeCutSourceEvidence[];
  brief_refs: string[];
  brief_mismatch: string;
  recommended_correction: string;
  uncertainty?: WholeCutUncertainty;
}

export interface WholeCutBriefMismatch {
  problem_id: string;
  axis_id: string;
  brief_refs: string[];
  observed_issue: string;
  why_it_matters: string;
}

export interface WholeCutRecommendedCorrection {
  problem_id: string;
  priority: "high" | "medium" | "low";
  recommendation: string;
  brief_refs: string[];
}

export interface WholeCutCutDensity {
  status: "measured" | "unmeasured";
  duration_sec: number;
  clip_count: number;
  cut_count: number;
  cuts_per_10_sec?: number;
  median_shot_sec?: number;
  timeline_evidence: {
    path: string;
    sha256: string;
  };
}

export interface WholeCutStoryProgression {
  status: "measured" | "degraded" | "unmeasured";
  score?: number;
  confidence?: number;
  confidence_basis: ConfidenceBasis;
  observation_ids: string[];
  relationship: "aligned" | "dense_without_progression" | "unmeasured";
  rationale: string;
}

export interface WholeCutMessageRetention {
  status: "retained" | "not_retained" | "unmeasured";
  confidence: number;
  confidence_basis: ConfidenceBasis;
  observation_ids: string[];
  rationale: string;
}

export interface WholeCutSemanticOutcomeRecord {
  status: WholeCutSemanticOutcome;
  confidence: number;
  confidence_basis: ConfidenceBasis;
  rationale: string;
}

export type WholeCutAlternativeDecision = "selected" | "rejected";
export type WholeCutAlternativeBriefFit = "strong" | "partial" | "weak";

/** Canonical comparison record for a low-confidence semantic choice. */
export interface WholeCutSemanticAlternative {
  alternative_id: string;
  axis_id: string;
  interpretation: string;
  edit_direction: string;
  render_evidence: WholeCutRenderRangeEvidence;
  source_evidence: WholeCutSourceEvidence[];
  risk: string;
  brief_fit: WholeCutAlternativeBriefFit;
  whole_cut_outcome: string;
  decision: WholeCutAlternativeDecision;
  decision_reason: string;
}

export interface WholeCutAlternativeEvaluation {
  status: "not_required" | "satisfied" | "missing" | "invalid";
  required_axis_ids: string[];
  distinct_alternative_count: number;
  rationale: string;
}

export interface WholeCutHumanHold {
  required: true;
  reason: string;
  clarification_question: WholeCutUncertainty["clarification_question"];
}

export interface WholeCutSemanticReview {
  version: typeof WHOLE_CUT_SEMANTIC_VERSION;
  evaluated_at: string;
  status: WholeCutSemanticStatus;
  render: WholeCutRenderEvidence;
  timeline: WholeCutTimelineIdentity;
  brief: WholeCutBriefIdentity;
  coverage: WholeCutCoverage;
  provider: WholeCutProviderRecord;
  observations: WholeCutObservation[];
  axis_results: WholeCutAxisResult[];
  problem_ranges: WholeCutProblemRange[];
  brief_mismatches: WholeCutBriefMismatch[];
  uncertainties: WholeCutUncertainty[];
  recommended_corrections: WholeCutRecommendedCorrection[];
  cut_density: WholeCutCutDensity;
  story_progression: WholeCutStoryProgression;
  message_retention: WholeCutMessageRetention;
  semantic_outcome: WholeCutSemanticOutcomeRecord;
  alternatives?: WholeCutSemanticAlternative[];
  alternative_evaluation: WholeCutAlternativeEvaluation;
  human_hold?: WholeCutHumanHold;
}

export interface WholeCutProviderEvidenceInput {
  render: {
    path: string;
    start_sec: number;
    end_sec: number;
    sha256: string;
  };
  source_clip_ids: string[];
}

export interface WholeCutProviderAxisResult {
  axis_id: string;
  outcome: WholeCutAxisOutcome;
  confidence: number;
  confidence_basis: ConfidenceBasis;
  brief_refs: string[];
  rationale: string;
}

export interface WholeCutSemanticProviderObservation {
  observation_id?: string;
  start_sec: number;
  end_sec: number;
  observation: string;
  inference: string;
  evidence: WholeCutProviderEvidenceInput;
  confidence: number;
  confidence_basis: ConfidenceBasis;
  axis_results?: WholeCutProviderAxisResult[];
  story_progression?: {
    score: number;
    confidence: number;
    confidence_basis: ConfidenceBasis;
  };
}

export interface WholeCutSemanticProviderProblem {
  problem_id?: string;
  axis_id: string;
  start_sec: number;
  end_sec: number;
  summary: string;
  observation_ids?: string[];
  evidence: WholeCutProviderEvidenceInput;
  brief_refs: string[];
  brief_mismatch: string;
  recommended_correction: string;
  uncertainty?: {
    description: string;
    impact: "high" | "low";
  };
}

export interface WholeCutSemanticProviderAlternative {
  alternative_id?: string;
  axis_id: string;
  interpretation: string;
  edit_direction: string;
  evidence: WholeCutProviderEvidenceInput;
  risk: string;
  brief_fit: WholeCutAlternativeBriefFit;
  whole_cut_outcome: string;
  decision: WholeCutAlternativeDecision;
  decision_reason: string;
}

export interface WholeCutSemanticProviderWindow {
  observations: WholeCutSemanticProviderObservation[];
  problem_ranges?: WholeCutSemanticProviderProblem[];
  alternatives?: WholeCutSemanticProviderAlternative[];
}

export interface WholeCutSemanticProviderInput {
  project_dir: string;
  render_path: string;
  render_sha256: string;
  timeline_path: string;
  timeline_sha256: string;
  timeline_version: string;
  start_sec: number;
  end_sec: number;
  duration_sec: number;
  active_clip_ids: string[];
  brief: CreativeBrief;
  axes: WholeCutSemanticAxis[];
}

export interface WholeCutSemanticProvider {
  id: string;
  capability?: WholeCutProviderCapability;
  model?: string;
  observeWindow(input: WholeCutSemanticProviderInput): Promise<WholeCutSemanticProviderWindow>;
}

export type AssembleWholeCut = (options: AssemblerOptions) => Promise<unknown>;

export interface WholeCutSemanticOptions {
  provider?: WholeCutSemanticProvider;
  /** Deprecated compatibility hint; production duration is always probed from the render. */
  durationSec?: number;
  renderPath?: string;
  renderIfMissing?: boolean;
  providerTimeoutMs?: number;
  windowDurationSec?: number;
  overlapSec?: number;
  /** Optional precomputed alternatives accepted when a provider returns them elsewhere. */
  alternatives?: WholeCutSemanticProviderAlternative[];
  createdAt?: string;
  now?: () => Date;
  assembleTimelineToMp4Impl?: AssembleWholeCut;
  /** Test seam for duration probing; production defaults to ffprobe. */
  probeRenderDurationImpl?: (renderPath: string) => Promise<number>;
}

interface TimelineClipRecord {
  clip_id: string;
  asset_id: string;
  track_kind: "video" | "audio";
  start_sec: number;
  end_sec: number;
  source_in_us: number;
  source_out_us: number;
}

interface ValidatedObservation {
  observation: WholeCutObservation;
  providerAxisResults: WholeCutProviderAxisResult[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function validRange(start: unknown, end: unknown): start is number {
  return finiteNumber(start) && finiteNumber(end) && start >= 0 && end > start;
}

function clampConfidence(value: number, basis: ConfidenceBasis): number {
  const bounded = Math.max(0, Math.min(1, value));
  return basis === "measured" ? bounded : Math.min(DEGRADED_CONFIDENCE_CEILING, bounded);
}

const CONFIDENCE_BASIS_RANK: Record<ConfidenceBasis, number> = {
  unmeasured: 0,
  degraded: 1,
  measured: 2,
};

/**
 * Child judgments cannot claim stronger support than the observation that
 * carries them. This keeps provider-provided axis/progression claims bound to
 * the observation's measured/degraded/unmeasured evidence basis and confidence.
 */
function bindConfidenceToObservation(
  childConfidence: number,
  childBasis: ConfidenceBasis,
  parentConfidence: number,
  parentBasis: ConfidenceBasis,
): { confidence: number; confidence_basis: ConfidenceBasis } {
  const confidence_basis = CONFIDENCE_BASIS_RANK[childBasis] <= CONFIDENCE_BASIS_RANK[parentBasis]
    ? childBasis
    : parentBasis;
  return {
    confidence: clampConfidence(Math.min(childConfidence, parentConfidence), confidence_basis),
    confidence_basis,
  };
}

function hashFileIfPresent(filePath: string): string | undefined {
  try {
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return undefined;
    return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
  } catch {
    return undefined;
  }
}

function hashObject(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function relativePath(projectDir: string, absolutePath: string): string {
  return path.relative(projectDir, absolutePath).split(path.sep).join("/");
}

function getBriefRef(brief: CreativeBrief, reference: string): unknown {
  const normalized = reference.startsWith("brief.") ? reference.slice("brief.".length) : reference;
  const tokens = normalized.match(/[^.[\]]+/g) ?? [];
  let current: unknown = brief;
  for (const token of tokens) {
    if (Array.isArray(current) && /^\d+$/.test(token)) {
      current = current[Number(token)];
    } else if (isRecord(current)) {
      current = current[token];
    } else {
      return undefined;
    }
  }
  return current;
}

function briefRefExists(brief: CreativeBrief, reference: string): boolean {
  const value = getBriefRef(brief, reference);
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return value !== undefined && value !== null;
}

function firstExistingBriefRefs(
  brief: CreativeBrief,
  candidates: string[],
  fallback = "message.primary",
): string[] {
  const refs = candidates.filter((reference, index) =>
    candidates.indexOf(reference) === index && briefRefExists(brief, reference),
  );
  return refs.length > 0 ? refs : [fallback];
}

/**
 * Convert the brief into the minimum Issue #32 axes plus explicit work-specific
 * must-have/must-avoid checks. The evaluator never substitutes this for a
 * provider's semantic observation; it is the contract the provider must cover.
 */
export function deriveWholeCutSemanticAxes(brief: CreativeBrief): WholeCutSemanticAxis[] {
  const minimum: WholeCutSemanticAxis[] = [
    {
      axis_id: "protagonist_story_identity",
      label: "Protagonist and story identity",
      source: "minimum",
      minimum: true,
      rationale: "Identify who or what carries the story and whether that identity stays stable.",
      brief_refs: firstExistingBriefRefs(brief, ["message.primary", "audience.primary", "content_hint"]),
    },
    {
      axis_id: "cause_action_progression",
      label: "Cause and action progression",
      source: "minimum",
      minimum: true,
      rationale: "Confirm that observed actions lead to the stated change rather than isolated montage.",
      brief_refs: firstExistingBriefRefs(brief, ["message.primary", "must_have[0]", "narrative_mode"]),
    },
    {
      axis_id: "semantic_agreement_or_intended_contrast",
      label: "VO, video, caption, and audio semantic agreement or intended contrast",
      source: "minimum",
      minimum: true,
      rationale: "Distinguish unsupported mismatch from a declared expressive contrast.",
      brief_refs: firstExistingBriefRefs(brief, ["message.primary", "audio_policy", "caption_policy", "must_avoid[0]"]),
    },
    {
      axis_id: "information_emotion_situation_progression",
      label: "Information, emotion, and situation progression",
      source: "minimum",
      minimum: true,
      rationale: "Evaluate the whole-cut arc, not only shot-level quality or scene count.",
      brief_refs: firstExistingBriefRefs(brief, ["emotion_curve", "message.primary"]),
    },
    {
      axis_id: "cut_density_vs_story_progression",
      label: "Cut density versus story progression",
      source: "minimum",
      minimum: true,
      rationale: "Keep mechanical cut density separate from measured semantic advancement.",
      brief_refs: firstExistingBriefRefs(brief, ["emotion_curve", "message.primary"]),
    },
    {
      axis_id: "role_time_context",
      label: "Role, time, and context clarity",
      source: "minimum",
      minimum: true,
      rationale: "Check role and temporal context while respecting an explicit editorial order.",
      brief_refs: firstExistingBriefRefs(brief, ["order_policy", "narrative_mode", "message.primary"]),
    },
    {
      axis_id: "intentional_ambiguity_vs_missing_explanation",
      label: "Intentional ambiguity or non-linearity versus missing explanation",
      source: "minimum",
      minimum: true,
      rationale: "Do not fail expressive ambiguity unless the brief or evidence shows it is accidental.",
      brief_refs: firstExistingBriefRefs(brief, ["order_policy", "forbidden_interpretations[0]", "hypotheses[0]"]),
    },
    {
      axis_id: "central_message_retention",
      label: "Retained central message",
      source: "minimum",
      minimum: true,
      rationale: "Test whether the final whole cut still communicates the primary brief message.",
      brief_refs: firstExistingBriefRefs(brief, ["message.primary", "message.secondary[0]"]),
    },
  ];

  const workSpecific: WholeCutSemanticAxis[] = [];
  const mustHave = Array.isArray((brief as Record<string, unknown>).must_have)
    ? (brief as Record<string, unknown>).must_have as unknown[]
    : [];
  mustHave.forEach((value, index) => {
    if (!hasText(value)) return;
    workSpecific.push({
      axis_id: `brief_must_have_${index + 1}`,
      label: `Brief must-have ${index + 1}`,
      source: "brief",
      minimum: false,
      rationale: "Evaluate a concrete must-have from this brief across the whole render.",
      brief_refs: [`must_have[${index}]`],
    });
  });
  const mustAvoid = Array.isArray((brief as Record<string, unknown>).must_avoid)
    ? (brief as Record<string, unknown>).must_avoid as unknown[]
    : [];
  mustAvoid.forEach((value, index) => {
    if (!hasText(value)) return;
    workSpecific.push({
      axis_id: `brief_must_avoid_${index + 1}`,
      label: `Brief must-avoid ${index + 1}`,
      source: "brief",
      minimum: false,
      rationale: "Check the whole cut for a stated brief-level failure mode.",
      brief_refs: [`must_avoid[${index}]`],
    });
  });
  return [...minimum, ...workSpecific];
}

function readTimelineClips(timeline: unknown): TimelineClipRecord[] {
  const sequence = isRecord(isRecord(timeline) ? timeline.sequence : undefined)
    ? (timeline as Record<string, unknown>).sequence as Record<string, unknown>
    : {};
  const fpsNum = finiteNumber(sequence.fps_num) && sequence.fps_num > 0 ? sequence.fps_num : 1;
  const fpsDen = finiteNumber(sequence.fps_den) && sequence.fps_den > 0 ? sequence.fps_den : 1;
  const fps = fpsNum / fpsDen;
  const tracks = isRecord(isRecord(timeline) ? timeline.tracks : undefined)
    ? (timeline as Record<string, unknown>).tracks as Record<string, unknown>
    : {};
  const clips: TimelineClipRecord[] = [];
  for (const trackKind of ["video", "audio"] as const) {
    const trackList = Array.isArray(tracks[trackKind]) ? tracks[trackKind] : [];
    trackList.forEach((track) => {
      if (!isRecord(track) || !Array.isArray(track.clips)) return;
      track.clips.forEach((clip) => {
        if (!isRecord(clip) || !hasText(clip.clip_id) || !hasText(clip.asset_id)) return;
        const startFrame = finiteNumber(clip.timeline_in_frame)
          ? clip.timeline_in_frame
          : finiteNumber(clip.start_frame) ? clip.start_frame : 0;
        const durationFrames = finiteNumber(clip.timeline_duration_frames)
          ? clip.timeline_duration_frames
          : finiteNumber(clip.duration_frames) ? clip.duration_frames : 0;
        const sourceIn = finiteNumber(clip.src_in_us) ? clip.src_in_us : 0;
        const sourceOut = finiteNumber(clip.src_out_us) && clip.src_out_us > sourceIn
          ? clip.src_out_us
          : sourceIn + Math.max(1, durationFrames / fps * 1_000_000);
        if (durationFrames <= 0) return;
        clips.push({
          clip_id: clip.clip_id,
          asset_id: clip.asset_id,
          track_kind: trackKind,
          start_sec: startFrame / fps,
          end_sec: (startFrame + durationFrames) / fps,
          source_in_us: sourceIn,
          source_out_us: sourceOut,
        });
      });
    });
  }
  return clips.sort((left, right) => left.start_sec - right.start_sec || left.clip_id.localeCompare(right.clip_id));
}

function activeClips(clips: TimelineClipRecord[], startSec: number, endSec: number): TimelineClipRecord[] {
  return clips.filter((clip) => clip.end_sec > startSec + COVERAGE_EPSILON_SEC && clip.start_sec < endSec - COVERAGE_EPSILON_SEC);
}

function renderEvidenceMatches(
  evidence: WholeCutProviderEvidenceInput | undefined,
  renderPath: string,
  renderHash: string,
  startSec: number,
  endSec: number,
): string | null {
  if (!evidence || !isRecord(evidence.render)) return "render evidence is missing";
  if (evidence.render.path !== renderPath) return "render evidence path is not the canonical whole-cut output";
  if (evidence.render.sha256 !== renderHash) return "render evidence hash does not match the current whole-cut bytes";
  if (!finiteNumber(evidence.render.start_sec) || !finiteNumber(evidence.render.end_sec) ||
    Math.abs(evidence.render.start_sec - startSec) > COVERAGE_EPSILON_SEC ||
    Math.abs(evidence.render.end_sec - endSec) > COVERAGE_EPSILON_SEC) {
    return "render evidence range does not match the observed range";
  }
  return null;
}

function sourceEvidenceFor(
  sourceIds: string[] | undefined,
  clips: TimelineClipRecord[],
  startSec: number,
  endSec: number,
  timelinePath: string,
  timelineVersion: string,
  timelineHash: string,
): { source?: WholeCutSourceEvidence[]; error?: string } {
  if (!Array.isArray(sourceIds) || sourceIds.length === 0) return { error: "source evidence has no clip identity" };
  const selected: WholeCutSourceEvidence[] = [];
  const seen = new Set<string>();
  for (const sourceId of sourceIds) {
    if (!hasText(sourceId) || seen.has(sourceId)) continue;
    seen.add(sourceId);
    const clip = clips.find((candidate) => candidate.clip_id === sourceId);
    if (!clip) return { error: `source evidence clip ${sourceId} is not in the canonical timeline` };
    if (clip.end_sec <= startSec + COVERAGE_EPSILON_SEC || clip.start_sec >= endSec - COVERAGE_EPSILON_SEC) {
      return { error: `source evidence clip ${sourceId} does not overlap its claimed render range` };
    }
    selected.push({
      timeline_path: timelinePath,
      timeline_version: timelineVersion,
      timeline_sha256: timelineHash,
      clip_id: clip.clip_id,
      asset_id: clip.asset_id,
      track_kind: clip.track_kind,
      timeline_start_sec: clip.start_sec,
      timeline_end_sec: clip.end_sec,
      source_range_us: { in_us: clip.source_in_us, out_us: clip.source_out_us },
    });
  }
  return selected.length > 0 ? { source: selected } : { error: "source evidence has no valid clip identity" };
}

function unionIntervals(
  intervals: Array<{ start_sec: number; end_sec: number }>,
  durationSec: number,
): Array<{ start_sec: number; end_sec: number }> {
  const sorted = intervals
    .filter((interval) => validRange(interval.start_sec, interval.end_sec))
    .map((interval) => ({
      start_sec: Math.max(0, Math.min(durationSec, interval.start_sec)),
      end_sec: Math.max(0, Math.min(durationSec, interval.end_sec)),
    }))
    .filter((interval) => interval.end_sec > interval.start_sec)
    .sort((left, right) => left.start_sec - right.start_sec || left.end_sec - right.end_sec);
  const merged: Array<{ start_sec: number; end_sec: number }> = [];
  for (const interval of sorted) {
    const previous = merged.at(-1);
    if (!previous || interval.start_sec > previous.end_sec + COVERAGE_EPSILON_SEC) {
      merged.push(interval);
    } else {
      previous.end_sec = Math.max(previous.end_sec, interval.end_sec);
    }
  }
  return merged;
}

function uncoveredRanges(
  intervals: Array<{ start_sec: number; end_sec: number }>,
  durationSec: number,
): Array<{ start_sec: number; end_sec: number }> {
  const gaps: Array<{ start_sec: number; end_sec: number }> = [];
  let cursor = 0;
  for (const interval of intervals) {
    if (interval.start_sec > cursor + COVERAGE_EPSILON_SEC) {
      gaps.push({ start_sec: cursor, end_sec: interval.start_sec });
    }
    cursor = Math.max(cursor, interval.end_sec);
  }
  if (cursor < durationSec - COVERAGE_EPSILON_SEC) gaps.push({ start_sec: cursor, end_sec: durationSec });
  return gaps;
}

function calculateAxisCoverage(
  intervals: Array<{ start_sec: number; end_sec: number }>,
  durationSec: number,
): WholeCutAxisCoverage {
  const merged = unionIntervals(intervals, durationSec);
  const uncovered = uncoveredRanges(merged, durationSec);
  return {
    status: uncovered.length === 0 && merged.length > 0 ? "complete" : merged.length > 0 ? "partial" : "missing",
    expected_duration_sec: durationSec,
    covered_duration_sec: merged.reduce((sum, interval) => sum + interval.end_sec - interval.start_sec, 0),
    intervals: merged,
    uncovered_ranges: uncovered,
  };
}

function buildWindows(durationSec: number, maxDurationSec: number, overlapSec: number): Array<{ start_sec: number; end_sec: number }> {
  const windows: Array<{ start_sec: number; end_sec: number }> = [];
  let cursor = 0;
  while (cursor < durationSec - COVERAGE_EPSILON_SEC) {
    const start = windows.length === 0 ? 0 : Math.max(0, cursor - overlapSec);
    const end = Math.min(durationSec, start + maxDurationSec);
    windows.push({ start_sec: start, end_sec: end });
    if (end >= durationSec - COVERAGE_EPSILON_SEC) break;
    cursor = end;
  }
  return windows.length > 0 ? windows : [{ start_sec: 0, end_sec: durationSec }];
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`semantic provider timed out after ${timeoutMs}ms`)), timeoutMs);
        (timer as unknown as { unref?: () => void }).unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function clarification(reason: string, axis?: string): WholeCutUncertainty["clarification_question"] {
  return {
    question: axis
      ? `Which interpretation should govern the whole cut for the ${axis} axis?`
      : "What evidence or human decision should resolve the whole-cut semantic uncertainty?",
    observation: reason,
    hypothesis: "The current semantic conclusion may be unsupported or may confuse an intended expression with a missing explanation.",
  };
}

function createHumanHold(reason: string, axis?: string): WholeCutHumanHold {
  return { required: true, reason, clarification_question: clarification(reason, axis) };
}

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function calculateCutDensity(
  projectDir: string,
  timeline: unknown,
  durationSec: number,
): WholeCutCutDensity {
  const timelinePath = path.join(projectDir, "05_timeline/timeline.json");
  const timelineHash = hashFileIfPresent(timelinePath) ?? hashObject(timeline);
  const clips = readTimelineClips(timeline).filter((clip) => clip.track_kind === "video");
  const shotDurations = clips.map((clip) => Math.max(0, clip.end_sec - clip.start_sec)).filter((value) => value > 0);
  const cutCount = Math.max(0, clips.length - 1);
  return {
    status: clips.length > 0 && durationSec > 0 ? "measured" : "unmeasured",
    duration_sec: durationSec,
    clip_count: clips.length,
    cut_count: cutCount,
    ...(durationSec > 0 && clips.length > 0 ? { cuts_per_10_sec: cutCount / durationSec * 10 } : {}),
    ...(median(shotDurations) !== undefined ? { median_shot_sec: median(shotDurations) } : {}),
    timeline_evidence: { path: "05_timeline/timeline.json", sha256: timelineHash },
  };
}

function baseReview(
  projectDir: string,
  brief: CreativeBrief,
  timeline: unknown,
  renderPath: string,
  durationSec: number,
  axes: WholeCutSemanticAxis[],
  provider: WholeCutProviderRecord,
  now: string,
): WholeCutSemanticReview {
  const timelinePath = path.join(projectDir, "05_timeline/timeline.json");
  const briefPath = path.join(projectDir, "01_intent/creative_brief.yaml");
  const renderHash = hashFileIfPresent(path.join(projectDir, renderPath));
  const timelineHash = hashFileIfPresent(timelinePath) ?? hashObject(timeline);
  const briefHash = hashFileIfPresent(briefPath) ?? hashObject(brief);
  const axisResults = axes.map((axis) => ({
    axis_id: axis.axis_id,
    outcome: "uncertain" as const,
    confidence: 0,
    confidence_basis: "unmeasured" as const,
    brief_refs: axis.brief_refs,
    observation_ids: [],
    coverage: calculateAxisCoverage([], durationSec),
    rationale: "No identity-bound semantic observation has evaluated this axis.",
  }));
  const cutDensity = calculateCutDensity(projectDir, timeline, durationSec);
  return {
    version: WHOLE_CUT_SEMANTIC_VERSION,
    evaluated_at: now,
    status: "blocked",
    render: {
      path: renderPath,
      ...(renderHash ? { sha256: renderHash } : {}),
      duration_sec: durationSec,
    },
    timeline: {
      path: "05_timeline/timeline.json",
      version: isRecord(timeline) && (typeof timeline.version === "string" || typeof timeline.version === "number")
        ? String(timeline.version)
        : "unknown",
      ...(timelineHash ? { sha256: timelineHash } : {}),
    },
    brief: {
      path: "01_intent/creative_brief.yaml",
      project_id: brief.project_id,
      ...(briefHash ? { sha256: briefHash } : {}),
      axes,
    },
    coverage: {
      status: "missing",
      expected_duration_sec: durationSec,
      covered_duration_sec: 0,
      intervals: [],
      uncovered_ranges: durationSec > 0 ? [{ start_sec: 0, end_sec: durationSec }] : [],
    },
    provider,
    observations: [],
    axis_results: axisResults,
    problem_ranges: [],
    brief_mismatches: [],
    uncertainties: [],
    recommended_corrections: [],
    cut_density: cutDensity,
    story_progression: {
      status: "unmeasured",
      confidence_basis: "unmeasured",
      observation_ids: [],
      relationship: "unmeasured",
      rationale: "Story progression requires semantic observations; cut count alone is not progression evidence.",
    },
    message_retention: {
      status: "unmeasured",
      confidence: 0,
      confidence_basis: "unmeasured",
      observation_ids: [],
      rationale: "The central message was not semantically evaluated.",
    },
    semantic_outcome: {
      status: "blocked",
      confidence: 0,
      confidence_basis: "unmeasured",
      rationale: "Whole-cut semantic PASS is unavailable until render coverage and semantic evidence are complete.",
    },
    alternative_evaluation: {
      status: "not_required",
      required_axis_ids: [],
      distinct_alternative_count: 0,
      rationale: "Alternatives are required only when a semantic choice remains below the measured confidence threshold.",
    },
  };
}

function addUncertainty(
  review: WholeCutSemanticReview,
  description: string,
  axis?: string,
  impact: "high" | "low" = "high",
): void {
  if (review.uncertainties.some((item) => item.description === description)) return;
  review.uncertainties.push({
    description,
    impact,
    clarification_question: clarification(description, axis),
  });
}

function isWholeCutPreviewPath(relative: string): boolean {
  const normalized = relative.toLowerCase();
  return normalized.includes("preview") || normalized === "05_timeline/preview-first30s.mp4";
}

function providerAxisMap(axes: WholeCutSemanticAxis[]): Map<string, WholeCutSemanticAxis> {
  return new Map(axes.map((axis) => [axis.axis_id, axis]));
}

function validateBriefRefs(brief: CreativeBrief, refs: string[]): string | null {
  if (!Array.isArray(refs) || refs.length === 0) return "brief binding is missing";
  const invalid = refs.find((reference) => !hasText(reference) || !briefRefExists(brief, reference));
  return invalid ? `brief reference ${String(invalid)} is not present in the canonical brief` : null;
}

function validateProviderObservation(
  raw: WholeCutSemanticProviderObservation,
  index: number,
  window: { start_sec: number; end_sec: number },
  durationSec: number,
  renderPath: string,
  renderHash: string,
  clips: TimelineClipRecord[],
  timelineHash: string,
  timelineVersion: string,
  axes: Map<string, WholeCutSemanticAxis>,
  brief: CreativeBrief,
): { value?: ValidatedObservation; errors: string[] } {
  const errors: string[] = [];
  if (!validRange(raw.start_sec, raw.end_sec) || raw.start_sec < -COVERAGE_EPSILON_SEC || raw.end_sec > durationSec + COVERAGE_EPSILON_SEC) {
    errors.push(`observation #${index + 1} has an invalid whole-cut range`);
  }
  if (raw.start_sec < window.start_sec - COVERAGE_EPSILON_SEC || raw.end_sec > window.end_sec + COVERAGE_EPSILON_SEC) {
    errors.push(`observation #${index + 1} claims coverage outside its requested provider window`);
  }
  if (!hasText(raw.observation) || !hasText(raw.inference)) errors.push(`observation #${index + 1} must separate observation and inference`);
  if (!finiteNumber(raw.confidence) || raw.confidence < 0 || raw.confidence > 1) errors.push(`observation #${index + 1} has invalid confidence`);
  if (!["measured", "degraded", "unmeasured"].includes(raw.confidence_basis)) errors.push(`observation #${index + 1} has invalid confidence basis`);

  const evidenceError = renderEvidenceMatches(raw.evidence, renderPath, renderHash, raw.start_sec, raw.end_sec);
  if (evidenceError) errors.push(`observation #${index + 1}: ${evidenceError}`);
  const source = sourceEvidenceFor(
    raw.evidence?.source_clip_ids,
    clips,
    raw.start_sec,
    raw.end_sec,
    "05_timeline/timeline.json",
    timelineVersion,
    timelineHash,
  );
  if (source.error) errors.push(`observation #${index + 1}: ${source.error}`);

  const axisResults: WholeCutProviderAxisResult[] = [];
  for (const axisResult of raw.axis_results ?? []) {
    if (!WHOLE_CUT_AXIS_OUTCOMES.has(axisResult.outcome)) {
      errors.push(`observation #${index + 1}, axis ${axisResult.axis_id}: unknown axis outcome is rejected`);
      continue;
    }
    if (!Object.hasOwn(CONFIDENCE_BASIS_RANK, axisResult.confidence_basis)) {
      errors.push(`observation #${index + 1}, axis ${axisResult.axis_id}: invalid confidence basis is rejected`);
      continue;
    }
    const axis = axes.get(axisResult.axis_id);
    if (!axis) {
      errors.push(`observation #${index + 1}: axis ${axisResult.axis_id} is not derived from the brief`);
      continue;
    }
    const refsError = validateBriefRefs(brief, axisResult.brief_refs);
    if (refsError) {
      errors.push(`observation #${index + 1}, axis ${axis.axis_id}: ${refsError}`);
      continue;
    }
    if (!Number.isFinite(axisResult.confidence) || axisResult.confidence < 0 || axisResult.confidence > 1) {
      errors.push(`observation #${index + 1}, axis ${axis.axis_id}: invalid confidence`);
      continue;
    }
    if (!hasText(axisResult.rationale)) {
      errors.push(`observation #${index + 1}, axis ${axis.axis_id}: rationale is missing`);
      continue;
    }
    const bounded = bindConfidenceToObservation(
      axisResult.confidence,
      axisResult.confidence_basis,
      raw.confidence,
      raw.confidence_basis,
    );
    axisResults.push({
      ...axisResult,
      ...bounded,
    });
  }

  if (raw.story_progression && !Object.hasOwn(CONFIDENCE_BASIS_RANK, raw.story_progression.confidence_basis)) {
    errors.push(`observation #${index + 1}: invalid story progression confidence basis is rejected`);
  }
  if (errors.length > 0 || !source.source) return { errors };
  const id = hasText(raw.observation_id) ? raw.observation_id : `observation_${index + 1}`;
  const progression = raw.story_progression &&
    finiteNumber(raw.story_progression.score) && raw.story_progression.score >= 0 && raw.story_progression.score <= 1 &&
    finiteNumber(raw.story_progression.confidence) && raw.story_progression.confidence >= 0 && raw.story_progression.confidence <= 1
    ? (() => {
        const bounded = bindConfidenceToObservation(
          raw.story_progression.confidence,
          raw.story_progression.confidence_basis,
          raw.confidence,
          raw.confidence_basis,
        );
        return {
          score: raw.story_progression.score,
          ...bounded,
        };
      })()
    : undefined;
  return {
    value: {
      observation: {
        observation_id: id,
        start_sec: Math.max(0, raw.start_sec),
        end_sec: Math.min(durationSec, raw.end_sec),
        observation: raw.observation,
        inference: raw.inference,
        evidence: {
          render: raw.evidence.render,
          source: source.source,
        },
        confidence: clampConfidence(raw.confidence, raw.confidence_basis),
        confidence_basis: raw.confidence_basis,
        axis_ids: axisResults.map((axis) => axis.axis_id),
        ...(progression ? { story_progression: progression } : {}),
      },
      providerAxisResults: axisResults,
    },
    errors,
  };
}

function normalizeProblem(
  raw: WholeCutSemanticProviderProblem,
  index: number,
  durationSec: number,
  renderPath: string,
  renderHash: string,
  clips: TimelineClipRecord[],
  timelineHash: string,
  timelineVersion: string,
  observations: WholeCutObservation[],
  axes: Map<string, WholeCutSemanticAxis>,
  brief: CreativeBrief,
): { value?: WholeCutProblemRange; error?: string } {
  const axis = axes.get(raw.axis_id);
  if (!axis) return { error: `problem range #${index + 1} references an axis not derived from the brief` };
  if (!validRange(raw.start_sec, raw.end_sec) || raw.end_sec > durationSec + COVERAGE_EPSILON_SEC) {
    return { error: `problem range #${index + 1} has an invalid whole-cut range` };
  }
  if (!hasText(raw.summary) || !hasText(raw.brief_mismatch) || !hasText(raw.recommended_correction)) {
    return { error: `problem range #${index + 1} must include mismatch and recommended correction` };
  }
  const evidenceError = renderEvidenceMatches(raw.evidence, renderPath, renderHash, raw.start_sec, raw.end_sec);
  if (evidenceError) return { error: `problem range #${index + 1}: ${evidenceError}` };
  const source = sourceEvidenceFor(
    raw.evidence.source_clip_ids,
    clips,
    raw.start_sec,
    raw.end_sec,
    "05_timeline/timeline.json",
    timelineVersion,
    timelineHash,
  );
  if (source.error || !source.source) return { error: `problem range #${index + 1}: ${source.error ?? "source evidence is missing"}` };
  const refsError = validateBriefRefs(brief, raw.brief_refs);
  if (refsError) return { error: `problem range #${index + 1}: ${refsError}` };
  const axisObservations = observations.filter((observation) => observation.axis_ids.includes(raw.axis_id));
  const defaultObservationIds = axisObservations
    .filter((observation) => observation.end_sec > raw.start_sec + COVERAGE_EPSILON_SEC && observation.start_sec < raw.end_sec - COVERAGE_EPSILON_SEC)
    .map((observation) => observation.observation_id);
  const observationIds = (raw.observation_ids ?? defaultObservationIds)
    .filter((id, idIndex, ids) => hasText(id) && ids.indexOf(id) === idIndex);
  if (observationIds.length === 0) {
    return { error: `problem range #${index + 1}: no observation covers this range for the cited axis` };
  }
  for (const observationId of observationIds) {
    const observation = observations.find((candidate) => candidate.observation_id === observationId);
    if (!observation) {
      return { error: `problem range #${index + 1}: observation ${observationId} is not bound to this evaluation` };
    }
    if (observation.end_sec <= raw.start_sec + COVERAGE_EPSILON_SEC || observation.start_sec >= raw.end_sec - COVERAGE_EPSILON_SEC) {
      return { error: `problem range #${index + 1}: observation ${observationId} does not overlap the problem range` };
    }
    if (!observation.axis_ids.includes(raw.axis_id)) {
      return { error: `problem range #${index + 1}: observation ${observationId} does not evaluate axis ${raw.axis_id}` };
    }
  }
  const citedObservationSourceKeys = new Set(
    observations
      .filter((observation) => observationIds.includes(observation.observation_id))
      .flatMap((observation) => observation.evidence.source.map(sourceEvidenceIdentityKey)),
  );
  if (source.source.some((source) => !citedObservationSourceKeys.has(sourceEvidenceIdentityKey(source)))) {
    return {
      error: `problem range #${index + 1}: source evidence is not bound to the cited same-axis observation identities`,
    };
  }
  const uncertainty = raw.uncertainty && hasText(raw.uncertainty.description)
    ? {
        description: raw.uncertainty.description,
        impact: raw.uncertainty.impact,
        clarification_question: clarification(raw.uncertainty.description, axis.label),
      }
    : undefined;
  return {
    value: {
      problem_id: hasText(raw.problem_id) ? raw.problem_id : `problem_${index + 1}`,
      axis_id: raw.axis_id,
      start_sec: Math.max(0, raw.start_sec),
      end_sec: Math.min(durationSec, raw.end_sec),
      summary: raw.summary,
      observation_ids: observationIds,
      render_evidence: raw.evidence.render,
      source_evidence: source.source,
      brief_refs: raw.brief_refs,
      brief_mismatch: raw.brief_mismatch,
      recommended_correction: raw.recommended_correction,
      ...(uncertainty ? { uncertainty } : {}),
    },
  };
}

function sourceEvidenceIdentityKey(source: WholeCutSourceEvidence): string {
  return [
    source.timeline_path,
    source.timeline_version,
    source.timeline_sha256,
    source.clip_id,
    source.asset_id,
    source.track_kind,
    source.timeline_start_sec,
    source.timeline_end_sec,
    source.source_range_us.in_us,
    source.source_range_us.out_us,
  ].join("\u0000");
}

function normalizeAlternativeKey(interpretation: string, editDirection: string): string {
  return `${interpretation.normalize("NFKC").toLocaleLowerCase().replace(/\s+/gu, " ").trim()}\u0000${editDirection.normalize("NFKC").toLocaleLowerCase().replace(/\s+/gu, " ").trim()}`;
}

function normalizeAlternative(
  raw: WholeCutSemanticProviderAlternative,
  index: number,
  durationSec: number,
  renderPath: string,
  renderHash: string,
  clips: TimelineClipRecord[],
  timelineHash: string,
  timelineVersion: string,
  axes: Map<string, WholeCutSemanticAxis>,
): { value?: WholeCutSemanticAlternative; error?: string } {
  const axis = axes.get(raw.axis_id);
  if (!axis) return { error: `alternative #${index + 1} references an axis not derived from the brief` };
  if (!hasText(raw.interpretation) || !hasText(raw.edit_direction) || !hasText(raw.risk) ||
    !hasText(raw.whole_cut_outcome) || !hasText(raw.decision_reason)) {
    return { error: `alternative #${index + 1} must include interpretation, edit direction, risk, outcome, and decision reason` };
  }
  if (!(["strong", "partial", "weak"] as string[]).includes(raw.brief_fit)) {
    return { error: `alternative #${index + 1} has an invalid brief-fit value` };
  }
  if (!(["selected", "rejected"] as string[]).includes(raw.decision)) {
    return { error: `alternative #${index + 1} must state selected or rejected` };
  }
  const render = raw.evidence?.render;
  if (!render || !validRange(render.start_sec, render.end_sec) || render.end_sec > durationSec + COVERAGE_EPSILON_SEC) {
    return { error: `alternative #${index + 1} has an invalid render evidence range` };
  }
  const evidenceError = renderEvidenceMatches(raw.evidence, renderPath, renderHash, render.start_sec, render.end_sec);
  if (evidenceError) return { error: `alternative #${index + 1}: ${evidenceError}` };
  const source = sourceEvidenceFor(
    raw.evidence.source_clip_ids,
    clips,
    render.start_sec,
    render.end_sec,
    "05_timeline/timeline.json",
    timelineVersion,
    timelineHash,
  );
  if (source.error || !source.source) return { error: `alternative #${index + 1}: ${source.error ?? "source evidence is missing"}` };
  return {
    value: {
      alternative_id: hasText(raw.alternative_id) ? raw.alternative_id : `alternative_${index + 1}`,
      axis_id: axis.axis_id,
      interpretation: raw.interpretation,
      edit_direction: raw.edit_direction,
      render_evidence: raw.evidence.render,
      source_evidence: source.source,
      risk: raw.risk,
      brief_fit: raw.brief_fit,
      whole_cut_outcome: raw.whole_cut_outcome,
      decision: raw.decision,
      decision_reason: raw.decision_reason,
    },
  };
}

function evaluateAlternativeRequirement(
  review: WholeCutSemanticReview,
  alternatives: WholeCutSemanticAlternative[],
): void {
  const lowConfidenceAxisIds = review.axis_results
    .filter((axis) => axis.outcome === "uncertain" || axis.confidence < HIGH_CONFIDENCE_THRESHOLD || axis.confidence_basis !== "measured")
    .map((axis) => axis.axis_id);
  if (review.story_progression.status !== "measured" ||
    (review.story_progression.confidence ?? 0) < HIGH_CONFIDENCE_THRESHOLD) {
    lowConfidenceAxisIds.push("information_emotion_situation_progression");
  }
  const requiredAxisIds = [...new Set(lowConfidenceAxisIds)];
  if (requiredAxisIds.length === 0) {
    review.alternative_evaluation = {
      status: "not_required",
      required_axis_ids: [],
      distinct_alternative_count: alternatives.length,
      rationale: "All measured semantic choices meet the high-confidence threshold; no alternative comparison is required.",
    };
    return;
  }

  const distinctKeys = new Set(
    alternatives.map((alternative) => normalizeAlternativeKey(alternative.interpretation, alternative.edit_direction)),
  );
  const missingAxes = requiredAxisIds.filter((axisId) => {
    const axisKeys = new Set(
      alternatives
        .filter((alternative) => alternative.axis_id === axisId)
        .map((alternative) => normalizeAlternativeKey(alternative.interpretation, alternative.edit_direction)),
    );
    return axisKeys.size < 2;
  });
  review.alternative_evaluation = {
    status: missingAxes.length === 0 ? "satisfied" : "missing",
    required_axis_ids: requiredAxisIds,
    distinct_alternative_count: distinctKeys.size,
    rationale: missingAxes.length === 0
      ? "Each low-confidence semantic choice has at least two distinct interpretation/edit alternatives with evidence, risk, brief fit, whole-cut outcome, and an explicit decision reason."
      : `Low-confidence semantic choices require at least two distinct interpretation/edit alternatives; missing or duplicate alternatives remain for: ${missingAxes.join(", ")}.`,
  };
  if (missingAxes.length > 0) {
    addUncertainty(
      review,
      review.alternative_evaluation.rationale,
      missingAxes[0],
      "high",
    );
  }
}

function aggregateAxisResults(
  axes: WholeCutSemanticAxis[],
  observations: WholeCutObservation[],
  providerAxisResults: Map<string, WholeCutProviderAxisResult[]>,
  durationSec: number,
): WholeCutAxisResult[] {
  return axes.map((axis) => {
    const results = providerAxisResults.get(axis.axis_id) ?? [];
    const axisObservations = observations
      .filter((observation) => observation.axis_ids.includes(axis.axis_id))
      .map((observation) => observation);
    const observationIds = [...new Set(axisObservations.map((observation) => observation.observation_id))];
    const coverage = calculateAxisCoverage(
      axisObservations.map((observation) => ({ start_sec: observation.start_sec, end_sec: observation.end_sec })),
      durationSec,
    );
    if (results.length === 0) {
      return {
        axis_id: axis.axis_id,
        outcome: "uncertain" as const,
        confidence: 0,
        confidence_basis: "unmeasured" as const,
        brief_refs: axis.brief_refs,
        observation_ids: observationIds,
        coverage,
        rationale: "No provider result evaluated this brief-derived axis across the whole cut.",
      };
    }
    if (coverage.status !== "complete") {
      const missing = coverage.uncovered_ranges.map((range) => `${range.start_sec}-${range.end_sec}s`).join(", ");
      return {
        axis_id: axis.axis_id,
        outcome: "uncertain" as const,
        confidence: 0,
        confidence_basis: "degraded" as const,
        brief_refs: [...new Set(results.flatMap((result) => result.brief_refs))],
        observation_ids: observationIds,
        coverage,
        rationale: `Semantic evidence for this brief-derived axis covers only part of the full cut; missing ranges: ${missing || "the full render"}. Overall render coverage does not establish per-axis coverage.`,
      };
    }
    const outcome = results.some((result) => result.outcome === "problem")
      ? "problem"
      : results.some((result) => result.outcome === "uncertain")
        ? "uncertain"
        : results.every((result) => result.outcome === "intentional_contrast")
          ? "intentional_contrast"
          : results.every((result) => result.outcome === "intentional_non_linear")
            ? "intentional_non_linear"
            : "pass";
    const basis: ConfidenceBasis = results.every((result) => result.confidence_basis === "measured") ? "measured" : "degraded";
    return {
      axis_id: axis.axis_id,
      outcome,
      confidence: Math.min(...results.map((result) => clampConfidence(result.confidence, basis))),
      confidence_basis: basis,
      brief_refs: [...new Set(results.flatMap((result) => result.brief_refs))],
      observation_ids: observationIds,
      coverage,
      rationale: [...new Set(results.map((result) => result.rationale))].join(" "),
    };
  });
}

function buildStoryProgression(
  observations: WholeCutObservation[],
  durationSec: number,
  cutDensity: WholeCutCutDensity,
): WholeCutStoryProgression {
  const progression = observations.filter((observation) => observation.story_progression);
  const progressionIntervals = unionIntervals(progression.map((observation) => ({ start_sec: observation.start_sec, end_sec: observation.end_sec })), durationSec);
  const gaps = uncoveredRanges(progressionIntervals, durationSec);
  if (progression.length === 0) {
    return {
      status: "unmeasured",
      confidence_basis: "unmeasured",
      observation_ids: [],
      relationship: "unmeasured",
      rationale: "No provider supplied story-progression observations; cut density is not a semantic substitute.",
    };
  }
  const measured = progression.every((observation) => observation.story_progression?.confidence_basis === "measured") &&
    progression.every((observation) => (observation.story_progression?.confidence ?? 0) >= HIGH_CONFIDENCE_THRESHOLD) &&
    gaps.length === 0;
  const score = progression.reduce((sum, observation) => sum + (observation.story_progression?.score ?? 0), 0) / progression.length;
  const confidence = Math.min(...progression.map((observation) => observation.story_progression?.confidence ?? 0));
  const dense = (cutDensity.cuts_per_10_sec ?? 0) >= 3 || (cutDensity.median_shot_sec ?? Number.POSITIVE_INFINITY) <= 2;
  const relationship = dense && score < 0.45 ? "dense_without_progression" : "aligned";
  return {
    status: measured ? "measured" : "degraded",
    score,
    confidence,
    confidence_basis: measured ? "measured" : "degraded",
    observation_ids: progression.map((observation) => observation.observation_id),
    relationship,
    rationale: relationship === "dense_without_progression"
      ? "Cut density is elevated while the provider measured little story progression; these signals remain separate."
      : gaps.length > 0
        ? "Story progression was reported only for part of the whole cut."
        : "Story progression was evaluated independently of mechanical cut density.",
  };
}

function buildMessageRetention(
  axisResults: WholeCutAxisResult[],
): WholeCutMessageRetention {
  const axis = axisResults.find((result) => result.axis_id === "central_message_retention");
  if (!axis || axis.outcome === "uncertain") {
    return {
      status: "unmeasured",
      confidence: 0,
      confidence_basis: "unmeasured",
      observation_ids: axis?.observation_ids ?? [],
      rationale: "The provider did not establish whether the primary brief message survives the whole cut.",
    };
  }
  return {
    status: axis.outcome === "problem" ? "not_retained" : "retained",
    confidence: axis.confidence,
    confidence_basis: axis.confidence_basis,
    observation_ids: axis.observation_ids,
    rationale: axis.rationale,
  };
}

function applySemanticVerdict(
  review: WholeCutSemanticReview,
  capability: WholeCutProviderCapability,
  invalidEvidence: string[],
): void {
  const hasUncertainAxis = review.axis_results.some((axis) => axis.outcome === "uncertain");
  const hasLowConfidence = review.axis_results.some((axis) => axis.confidence < HIGH_CONFIDENCE_THRESHOLD || axis.confidence_basis !== "measured");
  const progressionMeasured = review.story_progression.status === "measured";
  const messageMeasured = review.message_retention.status !== "unmeasured" && review.message_retention.confidence_basis === "measured";
  const complete = review.coverage.status === "complete";
  const evidenceReady = invalidEvidence.length === 0;

  if (!complete || !evidenceReady) {
    review.status = "blocked";
    review.semantic_outcome = {
      status: "blocked",
      confidence: 0,
      confidence_basis: "unmeasured",
      rationale: !complete
        ? "The semantic provider did not cover the render from start to finish."
        : "One or more provider evidence ranges or identities failed canonical binding.",
    };
    return;
  }

  if (capability === "available" && !hasUncertainAxis && !hasLowConfidence && progressionMeasured && messageMeasured) {
    review.status = "verified";
    const hasProblem = review.axis_results.some((axis) => axis.outcome === "problem") || review.story_progression.relationship === "dense_without_progression";
    const confidence = Math.min(
      ...review.axis_results.map((axis) => axis.confidence),
      review.story_progression.confidence ?? 1,
      review.message_retention.confidence,
    );
    review.semantic_outcome = {
      status: hasProblem ? "needs_revision" : "pass",
      confidence,
      confidence_basis: "measured",
      rationale: hasProblem
        ? "The full cut was semantically evaluated with bound evidence and contains one or more brief-relevant problems."
        : "The full cut was semantically evaluated with bound evidence across all brief-derived axes.",
    };
    return;
  }

  review.status = capability === "unavailable_optional" ? "unavailable" : "degraded";
  review.semantic_outcome = {
    status: "unmeasured",
    confidence: DEGRADED_CONFIDENCE_CEILING,
    confidence_basis: "degraded",
    rationale: "Whole-cut coverage exists, but semantic evidence is incomplete or low-confidence; no semantic PASS is allowed.",
  };
}

function addHumanHoldForReview(review: WholeCutSemanticReview): void {
  if (review.status === "verified") return;
  const reason = review.alternative_evaluation.status === "missing"
    ? review.alternative_evaluation.rationale
    : review.provider.capability === "unavailable_optional"
    ? "Optional semantic Vision/provider is unavailable; human whole-cut semantic review is required."
    : review.coverage.status !== "complete"
      ? "Whole-cut semantic coverage is partial; review the uncovered render ranges before relying on this critique."
      : review.uncertainties[0]?.description ?? "Semantic confidence is insufficient for an unattended editorial decision.";
  review.human_hold = createHumanHold(reason, review.uncertainties[0] ? undefined : "whole-cut semantic evaluation");
}

/**
 * Evaluate the actual rough render in bounded windows. A fresh canonical
 * render, its exact hash, a current timeline, and identity-bound source clip
 * ranges are prerequisites. Missing optional providers remain explicit HOLDs.
 */
export async function evaluateWholeCutSemantic(
  projectDir: string,
  brief: CreativeBrief,
  timeline: unknown,
  options: WholeCutSemanticOptions = {},
): Promise<WholeCutSemanticReview> {
  const absDir = path.resolve(projectDir);
  const renderAbsolute = path.resolve(absDir, options.renderPath ?? DEFAULT_WHOLE_CUT_RENDER_PATH);
  const renderRelative = relativePath(absDir, renderAbsolute);
  const axes = deriveWholeCutSemanticAxes(brief);
  const providerCapability = options.provider?.capability ?? (options.provider ? "available" : "unavailable_optional");
  const providerRecord: WholeCutProviderRecord = {
    provider_id: options.provider?.id ?? "optional-semantic-provider",
    capability: providerCapability,
    ...(options.provider?.model ? { model: options.provider.model } : {}),
    window_duration_sec: options.windowDurationSec ?? DEFAULT_WHOLE_CUT_WINDOW_SEC,
    overlap_sec: options.overlapSec ?? DEFAULT_WHOLE_CUT_OVERLAP_SEC,
    window_count: 0,
    completed_window_count: 0,
    degradation_reasons: [],
  };
  const createdAt = options.createdAt ?? options.now?.().toISOString() ?? new Date().toISOString();
  // durationSec remains a compatibility hint for older callers, but it must
  // never define or shorten the evidence horizon of a real render.
  const initialDuration = 0;
  const review = baseReview(absDir, brief, timeline, renderRelative, initialDuration, axes, providerRecord, createdAt);
  const timelinePath = path.join(absDir, "05_timeline/timeline.json");
  const timelineHash = hashFileIfPresent(timelinePath) ?? hashObject(timeline);
  const timelineVersion = review.timeline.version;

  if (path.isAbsolute(renderRelative) || renderRelative.startsWith("..") || isWholeCutPreviewPath(renderRelative)) {
    providerRecord.degradation_reasons.push("whole-cut evaluator received a preview or out-of-project render path");
    addUncertainty(review, "The requested render path is not the canonical full rough output.");
    review.human_hold = createHumanHold("Only the canonical full rough render may support whole-cut semantic review.");
    return review;
  }

  let freshness = assessRenderArtifactFreshness(absDir, renderAbsolute);
  if (freshness.status !== "fresh" && options.renderIfMissing === true) {
    try {
      const sourceInputsBefore = createSourceInputAttestation(absDir, { timelinePath });
      const assemble = options.assembleTimelineToMp4Impl ?? assembleTimelineToMp4;
      await assemble({ projectDir: absDir, timelinePath, outputPath: renderAbsolute });
      writeRenderFreshnessMetadata(absDir, renderAbsolute, { sourceInputsBefore, createdAt });
      freshness = assessRenderArtifactFreshness(absDir, renderAbsolute);
    } catch (error) {
      providerRecord.degradation_reasons.push(`whole-cut render failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (freshness.status !== "fresh") {
    providerRecord.degradation_reasons.push(`whole-cut render is not fresh (${freshness.status}${"reason" in freshness ? `:${freshness.reason}` : ""})`);
    addUncertainty(review, "The full rough render is missing or stale against the current timeline/source inputs.");
    review.human_hold = createHumanHold("Render the current full rough cut and rerun semantic review before relying on the result.");
    return review;
  }

  // Freshness uses the repository's compact reconciliation hash. Semantic
  // evidence uses the full content hash so provider ranges and the canonical
  // report share one unambiguous identity.
  const renderHash = hashFileIfPresent(renderAbsolute);
  if (!renderHash) {
    providerRecord.degradation_reasons.push("whole-cut render hash could not be computed");
    addUncertainty(review, "The full rough render has no computable identity hash.");
    review.human_hold = createHumanHold("A hash-bound full rough render is required for semantic evidence.");
    return review;
  }
  let resolvedDurationSec = 0;
  try {
    const probeDuration = options.probeRenderDurationImpl ?? (async (renderPath: string) =>
      extractDurationUs(await runFfprobe(renderPath)) / 1_000_000);
    resolvedDurationSec = await probeDuration(renderAbsolute);
  } catch (error) {
    providerRecord.degradation_reasons.push(`full render duration probe failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Number.isFinite(resolvedDurationSec) || resolvedDurationSec <= 0) {
    review.provider = providerRecord;
    review.render.duration_sec = 0;
    review.coverage.expected_duration_sec = 0;
    review.coverage.uncovered_ranges = [];
    addUncertainty(review, "The full rough render duration could not be measured.");
    review.human_hold = createHumanHold("A measured full-cut duration is required to prove start-to-finish coverage.");
    return review;
  }
  review.render.duration_sec = resolvedDurationSec;
  review.coverage.expected_duration_sec = resolvedDurationSec;
  review.coverage.uncovered_ranges = [{ start_sec: 0, end_sec: resolvedDurationSec }];
  review.axis_results = review.axis_results.map((axis) => ({
    ...axis,
    coverage: calculateAxisCoverage([], resolvedDurationSec),
  }));
  review.cut_density = calculateCutDensity(absDir, timeline, resolvedDurationSec);

  if (!options.provider || providerCapability === "unavailable_optional") {
    providerRecord.window_count = buildWindows(
      resolvedDurationSec,
      providerRecord.window_duration_sec,
      providerRecord.overlap_sec,
    ).length;
    providerRecord.degradation_reasons.push("optional semantic provider is unavailable; visual/metrics output is not semantic proof");
    review.status = "unavailable";
    review.provider = providerRecord;
    review.coverage = {
      status: "missing",
      expected_duration_sec: resolvedDurationSec,
      covered_duration_sec: 0,
      intervals: [],
      uncovered_ranges: [{ start_sec: 0, end_sec: resolvedDurationSec }],
    };
    review.semantic_outcome = {
      status: "blocked",
      confidence: 0,
      confidence_basis: "unmeasured",
      rationale: "No optional semantic provider supplied observations; visual QA, scene count, and timeline metrics cannot establish semantic PASS.",
    };
    addUncertainty(review, "No identity-bound semantic provider supplied observations for the full render.");
    addHumanHoldForReview(review);
    return review;
  }
  if (providerCapability === "failed") {
    providerRecord.degradation_reasons.push("semantic provider declared a failed capability");
    addUncertainty(review, "The configured semantic provider declared itself failed.");
    addHumanHoldForReview(review);
    return review;
  }

  const clipRecords = readTimelineClips(timeline);
  const axisMap = providerAxisMap(axes);
  const windows = buildWindows(resolvedDurationSec, providerRecord.window_duration_sec, providerRecord.overlap_sec);
  providerRecord.window_count = windows.length;
  const validObservations: WholeCutObservation[] = [];
  const allProviderAxisResults = new Map<string, WholeCutProviderAxisResult[]>();
  const rawProblems: WholeCutSemanticProviderProblem[] = [];
  const normalizedAlternatives: WholeCutSemanticAlternative[] = [];
  const invalidEvidence: string[] = [];
  const observationIds = new Set<string>();

  for (const window of windows) {
    try {
      const windowResult = await withTimeout(options.provider.observeWindow({
        project_dir: absDir,
        render_path: renderRelative,
        render_sha256: renderHash,
        timeline_path: "05_timeline/timeline.json",
        timeline_sha256: timelineHash,
        timeline_version: timelineVersion,
        start_sec: window.start_sec,
        end_sec: window.end_sec,
        duration_sec: resolvedDurationSec,
        active_clip_ids: activeClips(clipRecords, window.start_sec, window.end_sec).map((clip) => clip.clip_id),
        brief,
        axes,
      }), options.providerTimeoutMs ?? DEFAULT_WHOLE_CUT_PROVIDER_TIMEOUT_MS);
      let windowHadValidObservation = false;
      for (const [index, rawObservation] of (windowResult.observations ?? []).entries()) {
        const validated = validateProviderObservation(
          rawObservation,
          index,
          window,
          resolvedDurationSec,
          renderRelative,
          renderHash,
          clipRecords,
          timelineHash,
          timelineVersion,
          axisMap,
          brief,
        );
        if (validated.value) {
          let id = validated.value.observation.observation_id;
          if (observationIds.has(id)) id = `${id}_${validObservations.length + 1}`;
          validated.value.observation.observation_id = id;
          observationIds.add(id);
          validObservations.push(validated.value.observation);
          for (const axisResult of validated.value.providerAxisResults) {
            const entries = allProviderAxisResults.get(axisResult.axis_id) ?? [];
            entries.push(axisResult);
            allProviderAxisResults.set(axisResult.axis_id, entries);
          }
          windowHadValidObservation = true;
        }
        invalidEvidence.push(...validated.errors);
      }
      rawProblems.push(...(windowResult.problem_ranges ?? []));
      for (const [index, rawAlternative] of (windowResult.alternatives ?? []).entries()) {
        const normalized = normalizeAlternative(
          rawAlternative,
          normalizedAlternatives.length + index,
          resolvedDurationSec,
          renderRelative,
          renderHash,
          clipRecords,
          timelineHash,
          timelineVersion,
          axisMap,
        );
        if (normalized.value) normalizedAlternatives.push(normalized.value);
        else invalidEvidence.push(normalized.error ?? `alternative #${index + 1} failed validation`);
      }
      if (windowHadValidObservation) providerRecord.completed_window_count += 1;
      else providerRecord.degradation_reasons.push(`provider returned no valid observation for ${window.start_sec}-${window.end_sec}s`);
    } catch (error) {
      providerRecord.degradation_reasons.push(`provider window ${window.start_sec}-${window.end_sec}s failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  for (const [index, rawAlternative] of (options.alternatives ?? []).entries()) {
    const normalized = normalizeAlternative(
      rawAlternative,
      normalizedAlternatives.length + index,
      resolvedDurationSec,
      renderRelative,
      renderHash,
      clipRecords,
      timelineHash,
      timelineVersion,
      axisMap,
    );
    if (normalized.value) normalizedAlternatives.push(normalized.value);
    else invalidEvidence.push(normalized.error ?? `alternative #${index + 1} failed validation`);
  }

  review.observations = validObservations;
  review.coverage.intervals = unionIntervals(validObservations.map((observation) => ({ start_sec: observation.start_sec, end_sec: observation.end_sec })), resolvedDurationSec);
  review.coverage.covered_duration_sec = review.coverage.intervals.reduce((sum, interval) => sum + interval.end_sec - interval.start_sec, 0);
  review.coverage.uncovered_ranges = uncoveredRanges(review.coverage.intervals, resolvedDurationSec);
  review.coverage.status = review.coverage.uncovered_ranges.length === 0 && review.coverage.intervals.length > 0 ? "complete" : review.coverage.intervals.length > 0 ? "partial" : "missing";

  const normalizedProblems: WholeCutProblemRange[] = [];
  for (const [index, rawProblem] of rawProblems.entries()) {
    const normalized = normalizeProblem(
      rawProblem,
      index,
      resolvedDurationSec,
      renderRelative,
      renderHash,
      clipRecords,
      timelineHash,
      timelineVersion,
      validObservations,
      axisMap,
      brief,
    );
    if (normalized.value) normalizedProblems.push(normalized.value);
    else invalidEvidence.push(normalized.error ?? `problem range #${index + 1} failed validation`);
  }
  review.problem_ranges = normalizedProblems;
  review.alternatives = normalizedAlternatives;
  review.brief_mismatches = normalizedProblems.map((problem) => ({
    problem_id: problem.problem_id,
    axis_id: problem.axis_id,
    brief_refs: problem.brief_refs,
    observed_issue: problem.summary,
    why_it_matters: problem.brief_mismatch,
  }));
  review.recommended_corrections = normalizedProblems.map((problem) => ({
    problem_id: problem.problem_id,
    priority: "high" as const,
    recommendation: problem.recommended_correction,
    brief_refs: problem.brief_refs,
  }));
  review.axis_results = aggregateAxisResults(axes, validObservations, allProviderAxisResults, resolvedDurationSec);
  for (const axis of review.axis_results) {
    if (axis.outcome === "uncertain") {
      addUncertainty(
        review,
        axis.coverage.status === "complete"
          ? `Brief-derived axis ${axis.axis_id} was not evaluated with sufficient whole-cut semantic evidence.`
          : `Brief-derived axis ${axis.axis_id} lacks semantically adequate per-axis coverage; overall render coverage does not establish per-axis coverage.`,
        axis.axis_id,
      );
    }
    if (axis.outcome === "problem" && !normalizedProblems.some((problem) => problem.axis_id === axis.axis_id)) {
      invalidEvidence.push(`axis ${axis.axis_id} reported a problem without an identity-bound problem range`);
    }
  }
  review.story_progression = buildStoryProgression(validObservations, resolvedDurationSec, review.cut_density);
  if (review.story_progression.status !== "measured") addUncertainty(review, "Story progression was not measured across the complete render.", "information_emotion_situation_progression");
  review.message_retention = buildMessageRetention(review.axis_results);
  if (review.message_retention.status === "unmeasured") addUncertainty(review, "Central message retention was not measured across the complete render.", "central_message_retention");
  if (review.story_progression.relationship === "dense_without_progression") addUncertainty(review, "Cut density is high while measured story progression remains low.", "cut_density_vs_story_progression", "low");
  evaluateAlternativeRequirement(review, normalizedAlternatives);
  if (invalidEvidence.length > 0) providerRecord.degradation_reasons.push(...invalidEvidence.slice(0, 8));
  if (review.coverage.status !== "complete") addUncertainty(review, "Provider observations do not cover the render from start to finish.");
  if (providerCapability !== "available") addUncertainty(review, "The semantic provider is degraded or optional; measured semantic PASS is not supported.");
  review.provider = providerRecord;
  applySemanticVerdict(review, providerCapability, invalidEvidence);
  addHumanHoldForReview(review);
  return review;
}

/**
 * Re-check the identity-sensitive parts of an evaluated report immediately
 * before canonical promotion. This is intentionally separate from the broad
 * review-report schema so a report cannot self-assert a fresh render hash.
 */
export function validateWholeCutSemanticIdentity(
  projectDir: string,
  review: WholeCutSemanticReview,
): string[] {
  const absDir = path.resolve(projectDir);
  const errors: string[] = [];
  const renderPath = path.resolve(absDir, review.render.path);
  const currentRenderHash = hashFileIfPresent(renderPath);
  const currentTimelineHash = hashFileIfPresent(path.join(absDir, "05_timeline/timeline.json"));
  const currentBriefHash = hashFileIfPresent(path.join(absDir, "01_intent/creative_brief.yaml"));
  if (isWholeCutPreviewPath(review.render.path)) errors.push("whole-cut semantic render path points to a preview");
  if (currentRenderHash && review.render.sha256 !== currentRenderHash) errors.push("whole-cut semantic render hash drifted");
  if (currentTimelineHash && review.timeline.sha256 !== currentTimelineHash) errors.push("whole-cut semantic timeline hash drifted");
  if (currentBriefHash && review.brief.sha256 !== currentBriefHash) errors.push("whole-cut semantic brief hash drifted");
  if (review.status === "verified" && review.coverage.status !== "complete") errors.push("verified whole-cut semantic report does not prove complete coverage");
  for (const problem of review.problem_ranges) {
    if (problem.render_evidence.sha256 !== currentRenderHash) errors.push(`problem ${problem.problem_id} render evidence hash drifted`);
    if (Math.abs(problem.render_evidence.start_sec - problem.start_sec) > COVERAGE_EPSILON_SEC || Math.abs(problem.render_evidence.end_sec - problem.end_sec) > COVERAGE_EPSILON_SEC) {
      errors.push(`problem ${problem.problem_id} render evidence range drifted`);
    }
    if (!problem.source_evidence.every((source) => source.timeline_sha256 === currentTimelineHash)) errors.push(`problem ${problem.problem_id} source timeline identity drifted`);
    const citedObservations = problem.observation_ids.map((observationId) =>
      review.observations.find((observation) => observation.observation_id === observationId),
    );
    if (citedObservations.some((observation) => !observation)) {
      errors.push(`problem ${problem.problem_id} cites an observation outside the semantic review`);
      continue;
    }
    const boundObservations = citedObservations.filter((observation): observation is WholeCutObservation => !!observation);
    if (boundObservations.some((observation) =>
      !observation.axis_ids.includes(problem.axis_id) ||
      observation.end_sec <= problem.start_sec + COVERAGE_EPSILON_SEC ||
      observation.start_sec >= problem.end_sec - COVERAGE_EPSILON_SEC,
    )) {
      errors.push(`problem ${problem.problem_id} observation binding drifted from its range or axis`);
    }
    const citedSourceKeys = new Set(
      boundObservations.flatMap((observation) => observation.evidence.source.map(sourceEvidenceIdentityKey)),
    );
    if (problem.source_evidence.some((source) => !citedSourceKeys.has(sourceEvidenceIdentityKey(source)))) {
      errors.push(`problem ${problem.problem_id} source evidence is not bound to its cited same-axis observations`);
    }
  }
  for (const alternative of review.alternatives ?? []) {
    if (alternative.render_evidence.sha256 !== currentRenderHash) errors.push(`alternative ${alternative.alternative_id} render evidence hash drifted`);
    if (!alternative.source_evidence.every((source) => source.timeline_sha256 === currentTimelineHash)) {
      errors.push(`alternative ${alternative.alternative_id} source timeline identity drifted`);
    }
    if (!hasText(alternative.interpretation) || !hasText(alternative.edit_direction) ||
      !hasText(alternative.risk) || !hasText(alternative.whole_cut_outcome) || !hasText(alternative.decision_reason)) {
      errors.push(`alternative ${alternative.alternative_id} comparison fields are incomplete`);
    }
  }
  return errors;
}

export function wholeCutSemanticGateReason(review: WholeCutSemanticReview | undefined): string | null {
  if (!review) return "whole-cut semantic review is missing";
  if (review.status === "verified" && review.semantic_outcome.status === "pass") return null;
  return review.human_hold?.reason ?? review.semantic_outcome.rationale;
}

export function isWholeCutSemanticApprovalGrade(review: WholeCutSemanticReview | undefined): boolean {
  return review?.status === "verified" &&
    review.coverage.status === "complete" &&
    review.provider.capability === "available" &&
    review.semantic_outcome.status === "pass" &&
    review.semantic_outcome.confidence >= HIGH_CONFIDENCE_THRESHOLD &&
    review.semantic_outcome.confidence_basis === "measured";
}
