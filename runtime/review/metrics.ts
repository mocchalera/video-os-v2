import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { buildPairEvidence } from "../compiler/adjacency.js";
import type {
  Candidate,
  CreativeBrief,
  EditBlueprint,
  TimelineClip,
  TimelineIR,
} from "../compiler/types.js";
import type {
  AdjacencyAnalysis,
  AdjacencyPairResult,
  CutRelationAxis,
  CutRelationResult,
  CutRelationSignal,
} from "../compiler/transition-types.js";
import { validateAgainstSchema } from "../commands/shared.js";
import { assessDialogueCompleteness } from "../editorial/dialogue-completeness.js";

export type ReviewMetricTier =
  | "emotion"
  | "story"
  | "rhythm"
  | "eye_trace"
  | "plane_2d"
  | "space_3d"
  | "audio";

export type ReviewMetricStatus = "pass" | "warn" | "fail" | "skipped";

export type ReviewMetricId =
  | "rhythm.beat_duration_deviation"
  | "rhythm.max_shot_length"
  | "rhythm.cadence_distribution"
  | "story.required_roles"
  | "story.chronology"
  | "story.dialogue_completeness"
  | "emotion.peak_retention"
  | "emotion.hook_density"
  | "eye_trace.same_asset_adjacency"
  | "eye_trace.attention_jump"
  | "eye_trace.motion_flow"
  | "plane_2d.motif_overuse"
  | "plane_2d.framing_jump"
  | "plane_2d.luma_color_jump"
  | "space_3d.direction_axis"
  | "audio.speech_cut";

type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface ReviewMetricCheck {
  id: ReviewMetricId;
  tier: ReviewMetricTier;
  status: ReviewMetricStatus;
  measured: JsonValue;
  threshold: JsonValue;
  evidence: string[];
}

export interface ReviewMetricsSummary {
  total_checks: number;
  by_status: Record<ReviewMetricStatus, number>;
  by_tier: Partial<Record<ReviewMetricTier, Record<ReviewMetricStatus, number>>>;
}

export interface ReviewMetricsArtifact {
  version: "1" | "2";
  project_id: string;
  timeline_version: string;
  summary: ReviewMetricsSummary;
  checks: ReviewMetricCheck[];
}

export interface SegmentsArtifact {
  project_id?: string;
  artifact_version?: string;
  items?: SegmentItem[];
}

export interface SegmentItem {
  segment_id: string;
  asset_id: string;
  src_in_us: number;
  src_out_us: number;
  summary?: string;
  transcript_excerpt?: string;
  quality_flags?: string[];
  tags?: string[];
  peak_analysis?: {
    peak_moments?: PeakMoment[];
    support_signals?: {
      motion_support_score?: number;
      audio_support_score?: number;
      fused_peak_score?: number;
    };
  };
}

export interface PeakMoment {
  peak_ref: string;
  timestamp_us: number;
  type?: string;
  confidence: number;
  description?: string;
  source_pass?: string;
}

export interface TranscriptArtifact {
  project_id?: string;
  artifact_version?: string;
  transcript_ref?: string;
  asset_id: string;
  items?: TranscriptItem[];
}

export interface TranscriptItem {
  speaker?: string;
  start_us: number;
  end_us: number;
  text?: string;
}

export interface SelectsArtifact {
  version?: string;
  project_id?: string;
  candidates?: Candidate[];
}

export interface ReviewMetricsInputs {
  timeline?: TimelineIR;
  blueprint?: EditBlueprint;
  brief?: CreativeBrief;
  selects?: SelectsArtifact;
  segments?: SegmentsArtifact;
  transcripts?: TranscriptArtifact[];
  adjacency?: AdjacencyAnalysis;
}

export interface ReviewMetricsRunResult {
  metrics: ReviewMetricsArtifact;
  outputPath: string;
}

const DEFAULT_DURATION_TOLERANCE_PCT = 10;
const DEFAULT_MAX_SHOT_LENGTH_FRAMES = 144;
const DEFAULT_HOOK_DENSITY_MIN = 0.3;
const DEFAULT_MOTIF_REUSE_MAX = 2;
const DEFAULT_STRONG_PEAK_CONFIDENCE_MIN = 0.75;
const DEFAULT_SPEECH_CUT_GUARD_US = 80_000;
const CADENCE_COMPARISON_TOLERANCE_PCT = 5;

const TIERS: ReviewMetricTier[] = [
  "emotion",
  "story",
  "rhythm",
  "eye_trace",
  "plane_2d",
  "space_3d",
  "audio",
];

const STATUSES: ReviewMetricStatus[] = ["pass", "warn", "fail", "skipped"];

const RELATION_POLICY_SOURCE = "05_timeline/adjacency_analysis.json:pairs[].cut_relation";

interface RelationMetricDefinition {
  id: Extract<ReviewMetricId,
    | "eye_trace.attention_jump"
    | "eye_trace.motion_flow"
    | "plane_2d.framing_jump"
    | "plane_2d.luma_color_jump"
    | "space_3d.direction_axis">;
  tier: Extract<ReviewMetricTier, "eye_trace" | "plane_2d" | "space_3d">;
  axes: CutRelationAxis[];
  mappingReason: string;
}

const RELATION_METRICS: RelationMetricDefinition[] = [
  {
    id: "eye_trace.attention_jump",
    tier: "eye_trace",
    axes: ["composition", "text_presence"],
    mappingReason: "Attention continuity overlaps composition placement and overlay text presence; both canonical signals are retained instead of inventing a new attention threshold.",
  },
  {
    id: "eye_trace.motion_flow",
    tier: "eye_trace",
    axes: ["motion_flow"],
    mappingReason: "Motion flow maps directly to the canonical motion_flow signal.",
  },
  {
    id: "plane_2d.framing_jump",
    tier: "plane_2d",
    axes: ["shot_scale"],
    mappingReason: "Framing continuity maps to the canonical shot_scale signal.",
  },
  {
    id: "plane_2d.luma_color_jump",
    tier: "plane_2d",
    axes: ["luma", "dominant_color"],
    mappingReason: "Two-dimensional tonal continuity overlaps luma and dominant color; both canonical signals are surfaced without combining them into a new threshold.",
  },
  {
    id: "space_3d.direction_axis",
    tier: "space_3d",
    axes: ["gaze_axis"],
    mappingReason: "Screen-direction continuity maps to the canonical gaze_axis signal, which already carries the camera/gaze comparison evidence.",
  },
];

type AdjacencyBindingStatus = "bound" | "missing" | "mismatch";
type AdjacencyBindingMode = "clip_ids" | "legacy_refs" | null;

interface BoundAdjacencyPair {
  index: number;
  pair: AdjacencyPairResult;
  left: TimelineClip;
  right: TimelineClip;
}

interface AdjacencyBinding {
  status: AdjacencyBindingStatus;
  mode: AdjacencyBindingMode;
  reason_codes: string[];
  expected_pair_count: number;
  artifact_pair_count: number;
  pairs: BoundAdjacencyPair[];
}

function check(
  id: ReviewMetricId,
  tier: ReviewMetricTier,
  status: ReviewMetricStatus,
  measured: JsonValue,
  threshold: JsonValue,
  evidence: string[],
): ReviewMetricCheck {
  return {
    id,
    tier,
    status,
    measured,
    threshold,
    evidence: evidence.length > 0 ? evidence : ["No evidence emitted."],
  };
}

function skipped(id: ReviewMetricId, tier: ReviewMetricTier, reason: string): ReviewMetricCheck {
  return check(id, tier, "skipped", null, null, [reason]);
}

export function computeReviewMetrics(input: ReviewMetricsInputs): ReviewMetricsArtifact {
  const adjacencyBinding = bindAdjacencyToTimeline(input);
  const checks: ReviewMetricCheck[] = [
    checkBeatDurationDeviation(input),
    checkMaxShotLength(input),
    checkCadenceDistribution(input),
    checkRequiredRoles(input),
    checkChronology(input),
    checkDialogueCompleteness(input),
    checkPeakRetention(input),
    checkHookDensity(input),
    checkSameAssetAdjacency(input, adjacencyBinding),
    ...RELATION_METRICS.map((definition) =>
      checkRelationMetric(input, adjacencyBinding, definition)),
    checkMotifOveruse(input),
    checkSpeechCut(input),
  ];

  return {
    version: "2",
    project_id: resolveProjectId(input),
    timeline_version: input.timeline?.version ?? "unknown",
    summary: summarize(checks),
    checks,
  };
}

export function loadReviewMetricsInputs(projectDir: string): ReviewMetricsInputs {
  const absDir = path.resolve(projectDir);
  const timeline = readJsonIfExists<TimelineIR>(path.join(absDir, "05_timeline/timeline.json"));
  const blueprint = readYamlIfExists<EditBlueprint>(path.join(absDir, "04_plan/edit_blueprint.yaml"));
  const brief = readYamlIfExists<CreativeBrief>(path.join(absDir, "01_intent/creative_brief.yaml"));
  const selects = readYamlIfExists<SelectsArtifact>(path.join(absDir, "04_plan/selects_candidates.yaml"));
  const segments = readJsonIfExists<SegmentsArtifact>(path.join(absDir, "03_analysis/segments.json"));
  const adjacency = readJsonIfExists<AdjacencyAnalysis>(path.join(absDir, "05_timeline/adjacency_analysis.json"));
  const transcripts = readTranscriptArtifacts(path.join(absDir, "03_analysis/transcripts"));
  return { timeline, blueprint, brief, selects, segments, transcripts, adjacency };
}

export function writeReviewMetricsArtifact(
  projectDir: string,
  metrics: ReviewMetricsArtifact,
): string {
  const validation = validateAgainstSchema(metrics, "review-metrics.schema.json");
  if (!validation.valid) {
    throw new Error(`review_metrics.json failed schema validation: ${validation.errors.join("; ")}`);
  }

  const outPath = path.join(path.resolve(projectDir), "06_review/review_metrics.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const tmpPath = `${outPath}.tmp.${process.pid}`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(metrics, null, 2)}\n`, "utf-8");
  fs.renameSync(tmpPath, outPath);
  return outPath;
}

export function runReviewMetrics(
  projectDir: string,
  options: { timeline?: TimelineIR } = {},
): ReviewMetricsRunResult {
  const inputs = loadReviewMetricsInputs(projectDir);
  if (options.timeline) inputs.timeline = options.timeline;
  const metrics = computeReviewMetrics(inputs);
  const outputPath = writeReviewMetricsArtifact(projectDir, metrics);
  return { metrics, outputPath };
}

function readJsonIfExists<T>(filePath: string): T | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
}

function readYamlIfExists<T>(filePath: string): T | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  return parseYaml(fs.readFileSync(filePath, "utf-8")) as T;
}

function readTranscriptArtifacts(transcriptsDir: string): TranscriptArtifact[] {
  if (!fs.existsSync(transcriptsDir)) return [];
  return fs.readdirSync(transcriptsDir)
    .filter((file) => file.endsWith(".json"))
    .sort((a, b) => a.localeCompare(b))
    .map((file) => JSON.parse(
      fs.readFileSync(path.join(transcriptsDir, file), "utf-8"),
    ) as TranscriptArtifact);
}

function resolveProjectId(input: ReviewMetricsInputs): string {
  return input.timeline?.project_id ??
    input.blueprint?.project_id ??
    input.brief?.project_id ??
    input.selects?.project_id ??
    input.segments?.project_id ??
    "unknown";
}

function summarize(checks: ReviewMetricCheck[]): ReviewMetricsSummary {
  const byStatus = emptyStatusCounts();
  const byTier = Object.fromEntries(
    TIERS.map((tier) => [tier, emptyStatusCounts()]),
  ) as Record<ReviewMetricTier, Record<ReviewMetricStatus, number>>;

  for (const item of checks) {
    byStatus[item.status] += 1;
    byTier[item.tier][item.status] += 1;
  }

  return {
    total_checks: checks.length,
    by_status: byStatus,
    by_tier: byTier,
  };
}

function emptyStatusCounts(): Record<ReviewMetricStatus, number> {
  return { pass: 0, warn: 0, fail: 0, skipped: 0 };
}

function checkBeatDurationDeviation(input: ReviewMetricsInputs): ReviewMetricCheck {
  const id: ReviewMetricId = "rhythm.beat_duration_deviation";
  if (!input.timeline) return skipped(id, "rhythm", "timeline.json is missing.");
  if (!input.blueprint) return skipped(id, "rhythm", "edit_blueprint.yaml is missing.");

  const tolerance = input.blueprint.quality_targets?.duration_pacing_tolerance_pct ??
    DEFAULT_DURATION_TOLERANCE_PCT;
  const windows = resolveBeatWindows(input.timeline, input.blueprint);
  if (windows.length === 0) {
    return skipped(id, "rhythm", "No beat windows could be derived from markers or clip spans.");
  }

  const measuredBeats = windows.map((window) => {
    const endingTailFrames = endingTailFramesForBeat(input.timeline!, window.beatId);
    const pacingFrames = Math.max(0, window.actualFrames - endingTailFrames);
    const deviationPct = window.targetFrames > 0
      ? Math.abs(pacingFrames - window.targetFrames) / window.targetFrames * 100
      : 0;
    return {
      beat_id: window.beatId,
      target_frames: window.targetFrames,
      actual_frames: window.actualFrames,
      ...(endingTailFrames > 0
        ? { pacing_frames: pacingFrames, ending_treatment_frames: endingTailFrames }
        : {}),
      deviation_pct: round(deviationPct),
    };
  });
  const maxDeviation = measuredBeats.reduce((max, item) => Math.max(max, item.deviation_pct), 0);
  const status: ReviewMetricStatus = maxDeviation > tolerance * 2
    ? "fail"
    : maxDeviation > tolerance
      ? "warn"
      : "pass";
  const offenders = measuredBeats.filter((item) => item.deviation_pct > tolerance);
  const evidence = offenders.length > 0
    ? offenders.map((item) =>
        `${item.beat_id}: actual ${item.actual_frames}f vs target ${item.target_frames}f (${item.deviation_pct}% deviation)`,
      )
    : [`All ${measuredBeats.length} beat windows are within ${tolerance}% pacing tolerance.`];

  return check(id, "rhythm", status, {
    max_deviation_pct: round(maxDeviation),
    beats: measuredBeats,
  }, {
    warn_pct: tolerance,
    fail_pct: round(tolerance * 2),
  }, evidence);
}

function endingTailFramesForBeat(timeline: TimelineIR, beatId: string): number {
  return getVideoClips(timeline)
    .filter((clip) => clip.beat_id === beatId)
    .reduce((sum, clip) => {
      const treatment = clip.metadata?.ending_treatment;
      if (!treatment || typeof treatment !== "object") return sum;
      const extendedFrames = (treatment as Record<string, unknown>).extended_frames;
      return sum + (
        typeof extendedFrames === "number" && Number.isFinite(extendedFrames)
          ? Math.max(0, extendedFrames)
          : 0
      );
    }, 0);
}

function checkMaxShotLength(input: ReviewMetricsInputs): ReviewMetricCheck {
  const id: ReviewMetricId = "rhythm.max_shot_length";
  if (!input.timeline) return skipped(id, "rhythm", "timeline.json is missing.");

  const threshold = input.blueprint?.pacing?.max_shot_length_frames ??
    DEFAULT_MAX_SHOT_LENGTH_FRAMES;
  const clips = getVideoClips(input.timeline);
  if (clips.length === 0) return skipped(id, "rhythm", "No video clips found in timeline.");

  const violations = clips
    .filter((clip) => clip.timeline_duration_frames > threshold)
    .sort(compareClipOrder);
  const maxFrames = clips.reduce(
    (max, clip) => Math.max(max, clip.timeline_duration_frames),
    0,
  );

  return check(id, "rhythm", violations.length > 0 ? "fail" : "pass", {
    max_shot_length_frames: maxFrames,
    clips_over_threshold: violations.map((clip) => ({
      clip_id: clip.clip_id,
      beat_id: clip.beat_id ?? "",
      duration_frames: clip.timeline_duration_frames,
    })),
  }, {
    max_shot_length_frames: threshold,
  }, violations.length > 0
    ? violations.map((clip) =>
        `${clip.clip_id}: ${clip.timeline_duration_frames}f exceeds max ${threshold}f`,
      )
    : [`No video clip exceeds max_shot_length_frames=${threshold}.`]);
}

function checkCadenceDistribution(input: ReviewMetricsInputs): ReviewMetricCheck {
  const id: ReviewMetricId = "rhythm.cadence_distribution";
  if (!input.timeline) return skipped(id, "rhythm", "timeline.json is missing.");
  if (!input.blueprint) return skipped(id, "rhythm", "edit_blueprint.yaml is missing.");

  const v1 = getV1Clips(input.timeline);
  if (v1.length === 0) return skipped(id, "rhythm", "No V1 clips found in timeline.");

  const beatSections = assignBeatSections(input.blueprint);
  const sections: Record<"opening" | "middle" | "ending", number[]> = {
    opening: [],
    middle: [],
    ending: [],
  };
  for (const clip of v1) {
    const section = clip.beat_id ? beatSections.get(clip.beat_id) : undefined;
    if (section) sections[section].push(clip.timeline_duration_frames);
  }

  const sectionOrder = ["opening", "middle", "ending"] as const;
  const populatedSections = sectionOrder.filter((section) => sections[section].length > 0);
  if (populatedSections.length < 2) {
    return skipped(
      id,
      "rhythm",
      "At least two cadence sections must contain a V1 clip.",
    );
  }

  const averages = {
    opening: sections.opening.length > 0 ? round(mean(sections.opening)) : null,
    middle: sections.middle.length > 0 ? round(mean(sections.middle)) : null,
    ending: sections.ending.length > 0 ? round(mean(sections.ending)) : null,
  };
  const ranks = {
    opening: cadenceRank(input.blueprint.pacing.opening_cadence),
    middle: cadenceRank(input.blueprint.pacing.middle_cadence),
    ending: cadenceRank(input.blueprint.pacing.ending_cadence),
  };
  const comparisons = populatedSections.slice(0, -1)
    .map((left, index) => {
      const right = populatedSections[index + 1];
      return compareCadencePair(
        left,
        right,
        ranks[left],
        ranks[right],
        averages[left]!,
        averages[right]!,
      );
    })
    .filter((item): item is string => !!item);
  const measured = {
    average_shot_length_frames: averages,
    section_clip_counts: {
      opening: sections.opening.length,
      middle: sections.middle.length,
      ending: sections.ending.length,
    },
    cadence_rank: ranks,
  };

  return check(id, "rhythm", comparisons.length > 0 ? "fail" : "pass", measured, {
    opening_cadence: input.blueprint.pacing.opening_cadence,
    middle_cadence: input.blueprint.pacing.middle_cadence,
    ending_cadence: input.blueprint.pacing.ending_cadence,
    comparison_tolerance_pct: CADENCE_COMPARISON_TOLERANCE_PCT,
  }, comparisons.length > 0
    ? comparisons
    : [`Average V1 shot length order is consistent with cadence policy across ${populatedSections.join(" -> ")}.`]);
}

function checkRequiredRoles(input: ReviewMetricsInputs): ReviewMetricCheck {
  const id: ReviewMetricId = "story.required_roles";
  if (!input.timeline) return skipped(id, "story", "timeline.json is missing.");
  if (!input.blueprint) return skipped(id, "story", "edit_blueprint.yaml is missing.");

  const presentByBeat = new Map<string, Set<string>>();
  for (const clip of getAllClips(input.timeline)) {
    if (!clip.beat_id) continue;
    if (!presentByBeat.has(clip.beat_id)) presentByBeat.set(clip.beat_id, new Set());
    presentByBeat.get(clip.beat_id)!.add(clip.role);
  }

  const missing = input.blueprint.beats.flatMap((beat) => {
    const present = presentByBeat.get(beat.id) ?? new Set<string>();
    return beat.required_roles
      .filter((role) => !present.has(role))
      .map((role) => ({
        beat_id: beat.id,
        missing_role: role,
        present_roles: [...present].sort(),
      }));
  });

  return check(id, "story", missing.length > 0 ? "fail" : "pass", {
    missing_required_roles: missing,
  }, {
    required_roles_source: "edit_blueprint.beats[].required_roles",
  }, missing.length > 0
    ? missing.map((item) =>
        `${item.beat_id}: missing required role "${item.missing_role}" (present: ${item.present_roles.join(",") || "none"})`,
      )
    : ["Every blueprint beat has its required roles represented on the timeline."]);
}

function checkChronology(input: ReviewMetricsInputs): ReviewMetricCheck {
  const id: ReviewMetricId = "story.chronology";
  if (!input.timeline) return skipped(id, "story", "timeline.json is missing.");
  const policy = input.brief?.order_policy ?? input.blueprint?.timeline_order;
  if (policy !== "chronological") {
    return skipped(id, "story", "brief.order_policy is not chronological.");
  }

  const v1 = getV1Clips(input.timeline);
  if (v1.length < 2) return skipped(id, "story", "Fewer than two V1 clips found.");

  const lastByAsset = new Map<string, TimelineClip>();
  const inversions: Array<{
    previous_clip_id: string;
    clip_id: string;
    asset_id: string;
    previous_src_in_us: number;
    src_in_us: number;
  }> = [];

  for (const clip of v1) {
    const prev = lastByAsset.get(clip.asset_id);
    if (prev && clip.src_in_us < prev.src_in_us) {
      inversions.push({
        previous_clip_id: prev.clip_id,
        clip_id: clip.clip_id,
        asset_id: clip.asset_id,
        previous_src_in_us: prev.src_in_us,
        src_in_us: clip.src_in_us,
      });
    }
    const currentLast = lastByAsset.get(clip.asset_id);
    if (!currentLast || clip.src_in_us > currentLast.src_in_us) {
      lastByAsset.set(clip.asset_id, clip);
    }
  }

  return check(id, "story", inversions.length > 0 ? "fail" : "pass", {
    inversions,
    evaluated_scope: "V1 same-asset source order",
  }, {
    order_policy: "chronological",
  }, inversions.length > 0
    ? inversions.map((item) =>
        `${item.clip_id}: ${item.asset_id} src_in ${item.src_in_us} is before prior ${item.previous_clip_id} src_in ${item.previous_src_in_us}`,
      )
    : ["No same-asset V1 source chronology inversions found."]);
}

function checkPeakRetention(input: ReviewMetricsInputs): ReviewMetricCheck {
  const id: ReviewMetricId = "emotion.peak_retention";
  if (!input.timeline) return skipped(id, "emotion", "timeline.json is missing.");
  if (!input.segments) return skipped(id, "emotion", "segments.json is missing.");

  const segmentMap = buildSegmentMap(input.segments);
  const candidateMap = buildCandidateMap(input.selects);
  const strongPeakThreshold = DEFAULT_STRONG_PEAK_CONFIDENCE_MIN;
  const selectedClips = getAllClips(input.timeline);
  const selectedWindows = buildSelectedPeakWindows(selectedClips, candidateMap);
  const hasAnyPeakAnalysis = [...segmentMap.values()].some(
    (segment) => (segment.peak_analysis?.peak_moments?.length ?? 0) > 0,
  );
  if (!hasAnyPeakAnalysis) {
    return skipped(id, "emotion", "segments.json has no peak_analysis.peak_moments.");
  }

  const discarded: Array<{
    segment_id: string;
    peak_ref: string;
    timestamp_us: number;
    confidence: number;
  }> = [];
  let evaluatedStrongPeaks = 0;
  let ignoredStrongPeaksOutsideCandidateRanges = 0;
  const evaluatedKeys = new Set<string>();

  for (const window of selectedWindows) {
    const segment = segmentMap.get(window.segmentId);
    const strongPeaks = strongPeaksForSegment(segment, strongPeakThreshold);
    if (strongPeaks.length === 0) continue;
    for (const peak of strongPeaks) {
      if (!pointInUsRange(peak.timestamp_us, window.sourceInUs, window.sourceOutUs)) {
        ignoredStrongPeaksOutsideCandidateRanges += 1;
        continue;
      }

      const key = `${window.segmentId}:${peak.peak_ref}:${peak.timestamp_us}:${window.sourceInUs}:${window.sourceOutUs}`;
      if (evaluatedKeys.has(key)) continue;
      evaluatedKeys.add(key);
      evaluatedStrongPeaks += 1;

      const retained = window.clips.some((clip) =>
        peak.timestamp_us >= clip.src_in_us && peak.timestamp_us <= clip.src_out_us,
      );
      if (!retained) {
        discarded.push({
          segment_id: window.segmentId,
          peak_ref: peak.peak_ref,
          timestamp_us: peak.timestamp_us,
          confidence: round(peak.confidence),
        });
      }
    }
  }

  if (evaluatedStrongPeaks === 0) {
    return check(id, "emotion", "pass", {
      evaluated_strong_peaks: 0,
      discarded_strong_peaks: [],
      ignored_strong_peaks_outside_candidate_ranges: ignoredStrongPeaksOutsideCandidateRanges,
    }, {
      strong_peak_confidence_min: strongPeakThreshold,
    }, ["Selected timeline candidate ranges contain no strong peak moments to protect."]);
  }

  return check(id, "emotion", discarded.length > 0 ? "fail" : "pass", {
    evaluated_strong_peaks: evaluatedStrongPeaks,
    discarded_strong_peaks: discarded,
    ignored_strong_peaks_outside_candidate_ranges: ignoredStrongPeaksOutsideCandidateRanges,
  }, {
    strong_peak_confidence_min: strongPeakThreshold,
  }, discarded.length > 0
    ? discarded.map((item) =>
        `${item.segment_id}/${item.peak_ref}: strong peak at ${item.timestamp_us}us is outside selected source range`,
      )
    : [`All ${evaluatedStrongPeaks} strong selected-segment peaks are retained in source ranges.`]);
}

function checkHookDensity(input: ReviewMetricsInputs): ReviewMetricCheck {
  const id: ReviewMetricId = "emotion.hook_density";
  if (!input.timeline) return skipped(id, "emotion", "timeline.json is missing.");

  const v1 = getV1Clips(input.timeline);
  if (v1.length === 0) return skipped(id, "emotion", "No V1 clips found in timeline.");
  const hookWindow = resolveHookWindow(input.timeline, input.blueprint);
  const hookClips = v1.filter((clip) => rangesOverlapFrames(
    clip.timeline_in_frame,
    clip.timeline_in_frame + clip.timeline_duration_frames,
    hookWindow.startFrame,
    hookWindow.endFrame,
  ));
  if (hookClips.length === 0) return skipped(id, "emotion", "No V1 clips overlap the hook window.");

  const candidateMap = buildCandidateMap(input.selects);
  const segmentMap = input.segments ? buildSegmentMap(input.segments) : new Map<string, SegmentItem>();
  const hasSignalData = hookClips.some((clip) =>
    hasPeakSignalSource(clip, candidateMap, segmentMap),
  );
  if (!hasSignalData) {
    return skipped(
      id,
      "emotion",
      "Hook clips have no peak_analysis or candidate peak editorial signals.",
    );
  }

  const highSignalClips = hookClips.filter((clip) =>
    clipHasRetainedPeakSignal(clip, candidateMap, segmentMap),
  );
  const density = highSignalClips.length / hookClips.length;
  const target = input.blueprint?.quality_targets?.hook_density_min ?? DEFAULT_HOOK_DENSITY_MIN;
  const status: ReviewMetricStatus = density >= target
    ? "pass"
    : density >= target * 0.8
      ? "warn"
      : "fail";

  return check(id, "emotion", status, {
    hook_density: round(density),
    hook_window_frames: {
      start: hookWindow.startFrame,
      end: hookWindow.endFrame,
    },
    hook_clip_count: hookClips.length,
    high_signal_clip_ids: highSignalClips.map((clip) => clip.clip_id).sort(),
  }, {
    hook_density_min: target,
  }, status === "pass"
    ? [`Hook density ${round(density)} meets target ${target} using retained peak or editorial signals.`]
    : [`Hook density ${round(density)} is below target ${target} (${highSignalClips.length}/${hookClips.length} hook clips with retained peak signal).`]);
}

function bindAdjacencyToTimeline(input: ReviewMetricsInputs): AdjacencyBinding {
  const clips = input.timeline ? getV1Clips(input.timeline) : [];
  const expectedPairCount = Math.max(0, clips.length - 1);
  const artifactPairs = input.adjacency?.pairs ?? [];
  const base = {
    expected_pair_count: expectedPairCount,
    artifact_pair_count: artifactPairs.length,
    pairs: [] as BoundAdjacencyPair[],
  };

  if (!input.timeline || !input.adjacency) {
    return {
      ...base,
      status: "missing",
      mode: null,
      reason_codes: [!input.timeline ? "timeline_missing" : "adjacency_analysis_missing"],
    };
  }

  if (input.timeline.project_id !== input.adjacency.project_id) {
    return {
      ...base,
      status: "mismatch",
      mode: null,
      reason_codes: ["adjacency_timeline_mismatch", "project_id_mismatch"],
    };
  }

  if (artifactPairs.length !== expectedPairCount) {
    return {
      ...base,
      status: "mismatch",
      mode: null,
      reason_codes: ["adjacency_timeline_mismatch", "pair_count_mismatch"],
    };
  }

  const hasAnyClipIds = artifactPairs.some((pair) => pair.left_clip_id !== undefined || pair.right_clip_id !== undefined);
  const hasCompleteClipIds = artifactPairs.every((pair) =>
    typeof pair.left_clip_id === "string" && typeof pair.right_clip_id === "string");
  if (hasAnyClipIds && !hasCompleteClipIds) {
    return {
      ...base,
      status: "mismatch",
      mode: null,
      reason_codes: ["adjacency_timeline_mismatch", "partial_clip_id_binding"],
    };
  }

  const candidateMap = buildCandidateMap(input.selects);
  const mode: Exclude<AdjacencyBindingMode, null> = hasCompleteClipIds ? "clip_ids" : "legacy_refs";
  const reasons: string[] = [];
  const boundPairs: BoundAdjacencyPair[] = [];
  for (let index = 0; index < artifactPairs.length; index += 1) {
    const pair = artifactPairs[index];
    const left = clips[index];
    const right = clips[index + 1];
    const expectedPairId = `V1:${left.beat_id}->${right.beat_id}`;
    const expectedLeftRefs = expectedAdjacencyRefs(left, candidateMap);
    const expectedRightRefs = expectedAdjacencyRefs(right, candidateMap);
    if (pair.pair_id !== expectedPairId) reasons.push("beat_pair_mismatch");
    if (!expectedLeftRefs.includes(pair.left_candidate_ref) || !expectedRightRefs.includes(pair.right_candidate_ref)) {
      reasons.push("candidate_ref_mismatch");
    }
    if (mode === "clip_ids" &&
        (pair.left_clip_id !== left.clip_id || pair.right_clip_id !== right.clip_id)) {
      reasons.push("clip_id_mismatch");
    }
    boundPairs.push({ index, pair, left, right });
  }

  if (reasons.length > 0) {
    return {
      ...base,
      status: "mismatch",
      mode,
      reason_codes: ["adjacency_timeline_mismatch", ...[...new Set(reasons)].sort()],
    };
  }

  return {
    ...base,
    status: "bound",
    mode,
    reason_codes: [mode === "clip_ids" ? "ordered_clip_id_binding" : "ordered_legacy_ref_binding"],
    pairs: boundPairs,
  };
}

function expectedAdjacencyRefs(clip: TimelineClip, candidateMap: Map<string, Candidate>): string[] {
  const candidate = candidateForClip(clip, candidateMap);
  return [...new Set([
    candidate?.candidate_id,
    clip.candidate_ref,
    clip.segment_id,
    clip.clip_id,
  ].filter((value): value is string => typeof value === "string" && value.length > 0))].sort();
}

function checkRelationMetric(
  input: ReviewMetricsInputs,
  binding: AdjacencyBinding,
  definition: RelationMetricDefinition,
): ReviewMetricCheck {
  const threshold = relationMetricThreshold(input, definition);
  const measuredBase = {
    total_pairs: binding.expected_pair_count,
    evaluated_pairs: 0,
    unknown_pairs: binding.expected_pair_count,
    intentional_pairs: 0,
    risky_pairs: 0,
    binding: {
      status: binding.status,
      mode: binding.mode,
      reason_codes: binding.reason_codes,
      expected_pair_count: binding.expected_pair_count,
      artifact_pair_count: binding.artifact_pair_count,
    },
    pairs: [],
    violations: [],
    warnings: [],
  };

  if (binding.status !== "bound") {
    return check(
      definition.id,
      definition.tier,
      "skipped",
      measuredBase,
      threshold,
      [binding.status === "mismatch"
        ? `adjacency_timeline_mismatch: ${binding.reason_codes.join(", ")}; canonical relation evidence was not evaluated.`
        : "Canonical adjacency_analysis.json or timeline.json is missing; relation evidence was not evaluated."],
    );
  }
  if (binding.pairs.length === 0) {
    return check(definition.id, definition.tier, "skipped", measuredBase, threshold, [
      "The current V1 timeline has no adjacent clip pairs to evaluate.",
    ]);
  }

  let evaluatedPairs = 0;
  let unknownPairs = 0;
  let intentionalPairs = 0;
  let riskyPairs = 0;
  let relationPresentPairs = 0;
  const pairs: JsonValue[] = [];
  const violations: JsonValue[] = [];
  const warnings: JsonValue[] = [];

  for (const bound of binding.pairs) {
    const relation = bound.pair.cut_relation;
    if (!relation) {
      unknownPairs += 1;
      const finding = relationPairFinding(bound, definition, null, ["cut_relation_missing"], "warning");
      pairs.push(finding);
      warnings.push(finding);
      continue;
    }
    relationPresentPairs += 1;
    if (relation.relationship === "intentional_contrast") intentionalPairs += 1;
    if (relation.relationship === "risky_jump") riskyPairs += 1;

    const mappedSignals = definition.axes.map((axis) => ({ axis, signal: relation.signals?.[axis] }));
    const sufficientlyKnown = mappedSignals.every(({ signal }) =>
      signal !== undefined && (signal.coverage === "known" || signal.coverage === "not_applicable"));
    if (sufficientlyKnown) evaluatedPairs += 1;
    if (!sufficientlyKnown || relation.relationship === "unknown") unknownPairs += 1;

    const major = mappedSignals.some(({ signal }) => signal?.major_discontinuity === true);
    const contrast = mappedSignals.some(({ signal }) => signal?.evaluation === "contrast");
    const warningReasons: string[] = [];
    if (!sufficientlyKnown) warningReasons.push("axis_coverage_incomplete");
    if (relation.relationship === "unknown") warningReasons.push("cut_relationship_unknown");

    if (relation.relationship === "intentional_contrast") {
      const finding = relationPairFinding(
        bound,
        definition,
        relation,
        [...warningReasons, "intentional_contrast_excluded"],
        warningReasons.length > 0 ? "warning" : "intentional",
      );
      pairs.push(finding);
      if (warningReasons.length > 0) warnings.push(finding);
      continue;
    }

    if (relation.relationship === "risky_jump" && major) {
      const finding = relationPairFinding(
        bound,
        definition,
        relation,
        ["risky_jump_with_mapped_major_discontinuity"],
        "violation",
      );
      pairs.push(finding);
      violations.push(finding);
      continue;
    }

    if (major) warningReasons.push("mapped_major_without_risky_relation");
    else if (contrast) warningReasons.push("known_non_major_contrast");
    const finding = relationPairFinding(
      bound,
      definition,
      relation,
      warningReasons,
      warningReasons.length > 0 ? "warning" : "clean",
    );
    pairs.push(finding);
    if (warningReasons.length > 0) warnings.push(finding);
  }

  const measured = {
    ...measuredBase,
    evaluated_pairs: evaluatedPairs,
    unknown_pairs: unknownPairs,
    intentional_pairs: intentionalPairs,
    risky_pairs: riskyPairs,
    pairs,
    violations,
    warnings,
  };
  if (relationPresentPairs === 0) {
    return check(definition.id, definition.tier, "skipped", measured, threshold, [
      "All bound adjacency pairs are missing cut_relation; no relation finding was evaluated.",
    ]);
  }

  const status: ReviewMetricStatus = violations.length > 0
    ? "fail"
    : warnings.length > 0 || relationPresentPairs < binding.pairs.length
      ? "warn"
      : "pass";
  const evidence = status === "fail"
    ? [`${violations.length} bound pair(s) have risky_jump with a mapped major discontinuity.`]
    : status === "warn"
      ? [`${warnings.length} bound pair finding(s) remain advisory because relation or axis evidence is partial, unknown, or non-major.`]
      : [`All ${binding.pairs.length} bound pair(s) are sufficiently covered for ${definition.axes.join(" + ")} with no continuity finding.`];
  return check(definition.id, definition.tier, status, measured, threshold, evidence);
}

function relationMetricThreshold(
  input: ReviewMetricsInputs,
  definition: RelationMetricDefinition,
): JsonValue {
  return {
    advisory: true,
    policy_source: "runtime/compiler/cut-relation.ts:CUT_RELATION_THRESHOLDS",
    canonical_relation_source: RELATION_POLICY_SOURCE,
    decision_rule: "canonical_relationship_and_signal_major_discontinuity",
    axis_mapping: definition.axes,
    axis_mapping_reason: definition.mappingReason,
    profile_brief_signal: {
      resolved_profile_id: input.blueprint?.resolved_profile?.id ?? null,
      brief_profile_hint: input.brief?.editorial?.profile_hint ?? null,
      brief_policy_hint: input.brief?.editorial?.policy_hint ?? null,
      threshold_override_applied: false,
    },
  };
}

function relationPairFinding(
  bound: BoundAdjacencyPair,
  definition: RelationMetricDefinition,
  relation: CutRelationResult | null,
  findingReasonCodes: string[],
  outcome: "clean" | "intentional" | "violation" | "warning",
): JsonValue {
  return {
    pair_index: bound.index,
    pair_id: bound.pair.pair_id,
    left_clip_id: bound.left.clip_id,
    right_clip_id: bound.right.clip_id,
    left_ref: bound.pair.left_candidate_ref,
    right_ref: bound.pair.right_candidate_ref,
    left_beat_id: bound.left.beat_id,
    right_beat_id: bound.right.beat_id,
    relationship: relation?.relationship ?? "missing",
    relation_confidence: relation?.confidence ?? null,
    relation_reason_codes: relation?.reason_codes ?? [],
    explicit_intent_evidence: intentEvidenceMeasured(relation),
    mapped_axes: definition.axes,
    axis_signals: definition.axes.map((axis) => relationSignalMeasured(axis, relation?.signals?.[axis])),
    outcome,
    finding_reason_codes: findingReasonCodes,
    description: relationFindingDescription(definition.id, bound, relation, findingReasonCodes),
  };
}

function relationSignalMeasured(axis: CutRelationAxis, signal: CutRelationSignal | undefined): JsonValue {
  if (!signal) {
    return {
      axis_id: axis,
      coverage: "missing",
      evaluation: "unknown",
      major_discontinuity: false,
      raw: { left: null, right: null },
      raw_coverage: { left: "missing", right: "missing", pair: "missing" },
      source_refs: { left: [], right: [] },
      confidence: { left: null, right: null },
      reason_codes: ["cut_relation_signal_missing"],
    };
  }
  return {
    axis_id: axis,
    coverage: signal.coverage,
    evaluation: signal.evaluation,
    major_discontinuity: signal.major_discontinuity,
    raw: signal.raw as JsonValue,
    raw_coverage: signal.raw_coverage as unknown as JsonValue,
    source_refs: signal.source_refs,
    confidence: signal.confidence,
    reason_codes: signal.reason_codes,
  };
}

function intentEvidenceMeasured(relation: CutRelationResult | null | undefined): JsonValue[] {
  return (relation?.explicit_intent_evidence ?? []).map((item) => ({
    source: item.source,
    source_ref: item.source_ref,
    intent: item.intent,
  }));
}

function relationFindingDescription(
  metricId: ReviewMetricId,
  bound: BoundAdjacencyPair,
  relation: CutRelationResult | null,
  reasons: string[],
): string {
  return `${metricId} ${bound.left.clip_id}->${bound.right.clip_id}: relationship=${relation?.relationship ?? "missing"}; ${reasons.join(", ") || "no continuity finding"}`;
}

function checkSameAssetAdjacency(input: ReviewMetricsInputs, binding: AdjacencyBinding): ReviewMetricCheck {
  const id: ReviewMetricId = "eye_trace.same_asset_adjacency";
  if (!input.timeline) return skipped(id, "eye_trace", "timeline.json is missing.");

  const v1 = getV1Clips(input.timeline);
  const selectedCandidateAssetIds = uniqueSortedAssetIds(input.selects?.candidates ?? []);
  const timelineAssetIds = uniqueSortedAssetIds(v1);
  if (binding.status === "mismatch") {
    return check(id, "eye_trace", "skipped", {
      adjacent_pairs: Math.max(0, v1.length - 1),
      same_asset_pairs: [],
      untreated_same_asset_pairs: [],
      visually_differentiated_pairs: [],
      intentional_pairs: [],
      violations: [],
      warnings: [],
      v1_asset_ids: timelineAssetIds,
      selected_candidate_asset_ids: selectedCandidateAssetIds,
      binding: {
        status: binding.status,
        mode: binding.mode,
        reason_codes: binding.reason_codes,
        expected_pair_count: binding.expected_pair_count,
        artifact_pair_count: binding.artifact_pair_count,
      },
    }, {
      advisory: true,
      policy_source: RELATION_POLICY_SOURCE,
      max_same_asset_adjacent_pairs: 0,
      scope: "V1",
    }, [`adjacency_timeline_mismatch: ${binding.reason_codes.join(", ")}; same-asset findings were not evaluated without trustworthy intent binding.`]);
  }
  if (v1.length < 2) {
    return check(id, "eye_trace", "pass", {
      adjacent_pairs: 0,
      same_asset_pairs: [],
      untreated_same_asset_pairs: [],
      visually_differentiated_pairs: [],
      intentional_pairs: [],
      violations: [],
      warnings: [],
      v1_asset_ids: timelineAssetIds,
      selected_candidate_asset_ids: selectedCandidateAssetIds,
    }, {
      max_same_asset_adjacent_pairs: 0,
      scope: "V1",
    }, ["Fewer than two V1 clips; same-asset adjacency cannot occur."]);
  }

  const candidateMap = buildCandidateMap(input.selects);
  type SameAssetPair = {
    pair_id: string;
    left_clip_id: string;
    right_clip_id: string;
    left_ref: string;
    right_ref: string;
    asset_id: string;
    relationship: string;
    relation_reason_codes: string[];
    explicit_intent_evidence: JsonValue[];
    description: string;
  };
  const sameAssetPairs: SameAssetPair[] = [];
  const violations: SameAssetPair[] = [];
  const visuallyDifferentiatedPairs: Array<SameAssetPair & { treatment: "punch_in" }> = [];
  const intentionalPairs: SameAssetPair[] = [];

  for (let i = 0; i < v1.length - 1; i++) {
    const left = v1[i];
    const right = v1[i + 1];
    const pair = buildPairEvidence(
      left,
      right,
      candidateForClip(left, candidateMap),
      candidateForClip(right, candidateMap),
      undefined,
      undefined,
      undefined,
      undefined,
      "guide",
    );
    if (pair.same_asset) {
      const adjacencyPair = binding.status === "bound" ? binding.pairs[i]?.pair : undefined;
      const relation = adjacencyPair?.cut_relation;
      const item = {
        pair_id: adjacencyPair?.pair_id ?? `V1:${left.beat_id}->${right.beat_id}`,
        left_clip_id: left.clip_id,
        right_clip_id: right.clip_id,
        left_ref: adjacencyPair?.left_candidate_ref ?? left.candidate_ref ?? left.segment_id,
        right_ref: adjacencyPair?.right_candidate_ref ?? right.candidate_ref ?? right.segment_id,
        asset_id: left.asset_id,
        relationship: relation?.relationship ?? "unknown",
        relation_reason_codes: relation?.reason_codes ?? ["cut_relation_missing"],
        explicit_intent_evidence: intentEvidenceMeasured(relation),
        description: `${id} ${left.clip_id}->${right.clip_id}: adjacent V1 clips reuse ${left.asset_id}`,
      };
      sameAssetPairs.push(item);
      if (hasPunchInDifferentiation(left, right)) {
        visuallyDifferentiatedPairs.push({ ...item, treatment: "punch_in" });
      } else if (relation?.relationship === "intentional_contrast") {
        intentionalPairs.push(item);
      } else {
        violations.push(item);
      }
    }
  }

  const singleAssetPool = violations.length > 0 &&
    selectedCandidateAssetIds.length === 1 &&
    timelineAssetIds.length === 1 &&
    selectedCandidateAssetIds[0] === timelineAssetIds[0];
  const longformReduction = input.brief?.longform?.mode === "reduction";
  const status: ReviewMetricStatus = violations.length === 0 || longformReduction
    ? "pass"
    : singleAssetPool
      ? "warn"
      : "fail";

  return check(id, "eye_trace", status, {
    adjacent_pairs: v1.length - 1,
    same_asset_pairs: sameAssetPairs,
    untreated_same_asset_pairs: violations,
    visually_differentiated_pairs: visuallyDifferentiatedPairs,
    intentional_pairs: intentionalPairs,
    violations: longformReduction ? [] : violations,
    warnings: !longformReduction && singleAssetPool ? violations : [],
    v1_asset_ids: timelineAssetIds,
    selected_candidate_asset_ids: selectedCandidateAssetIds,
    binding: {
      status: binding.status,
      mode: binding.mode,
      reason_codes: binding.reason_codes,
      expected_pair_count: binding.expected_pair_count,
      artifact_pair_count: binding.artifact_pair_count,
    },
  }, {
    advisory: true,
    policy_source: RELATION_POLICY_SOURCE,
    max_same_asset_adjacent_pairs: 0,
    scope: "V1",
    longform_continuity_allowed: longformReduction,
  }, longformReduction && violations.length > 0
    ? ["Same-asset adjacency is expected in chronological longform reduction; chronology and speech-boundary checks remain authoritative."]
    : violations.length > 0
    ? [
        ...(singleAssetPool
          ? [`Selected candidates expose only 1 unique asset (${selectedCandidateAssetIds[0]}); same-asset adjacency is unavoidable and remains a review warning until broader visual candidates exist.`]
          : []),
        ...violations.map((item) =>
        `${item.left_clip_id}->${item.right_clip_id}: adjacent V1 clips reuse ${item.asset_id}`,
        ),
      ]
    : visuallyDifferentiatedPairs.length > 0 || intentionalPairs.length > 0
      ? [`All same-asset adjacent pair(s) are visually differentiated or exempt through ${visuallyDifferentiatedPairs.length} explicit punch-in treatment(s) and ${intentionalPairs.length} canonical intentional contrast(s).`]
      : ["No adjacent V1 clips reuse the same asset."]);
}

function hasPunchInDifferentiation(left: TimelineClip, right: TimelineClip): boolean {
  const leftZoom = typeof left.metadata?.zoom === "number" ? left.metadata.zoom : 1;
  const rightZoom = typeof right.metadata?.zoom === "number" ? right.metadata.zoom : 1;
  if (rightZoom - leftZoom < 0.05) return false;

  const editorial = recordValue(right.metadata?.editorial);
  const cameraMove = recordValue(editorial?.camera_move);
  return cameraMove?.type === "punch_in";
}

function uniqueSortedAssetIds(items: Array<{ asset_id?: string }>): string[] {
  return [...new Set(items.map((item) => item.asset_id).filter((value): value is string => Boolean(value)))]
    .sort((a, b) => a.localeCompare(b));
}

function checkMotifOveruse(input: ReviewMetricsInputs): ReviewMetricCheck {
  const id: ReviewMetricId = "plane_2d.motif_overuse";
  if (!input.timeline) return skipped(id, "plane_2d", "timeline.json is missing.");
  if (!input.selects) return skipped(id, "plane_2d", "selects_candidates.yaml is missing.");

  const candidateMap = buildCandidateMap(input.selects);
  const videoClips = getVideoClips(input.timeline);
  const longformReduction = input.brief?.longform?.mode === "reduction";
  const intentionalRepetition = longformReduction ||
    input.blueprint?.dedupe_rules?.allow_intentional_repetition === true;
  const threshold = intentionalRepetition
    ? Number.POSITIVE_INFINITY
    : DEFAULT_MOTIF_REUSE_MAX;
  const motifCounts = new Map<string, number>();
  const unresolvedClipIds: string[] = [];

  for (const clip of videoClips) {
    const candidate = candidateForClip(clip, candidateMap);
    if (!candidate) {
      unresolvedClipIds.push(clip.clip_id);
      continue;
    }
    for (const tag of candidate.motif_tags ?? []) {
      motifCounts.set(tag, (motifCounts.get(tag) ?? 0) + 1);
    }
  }

  if (motifCounts.size === 0) {
    return skipped(id, "plane_2d", "No selected video candidates expose motif_tags.");
  }

  const overused = [...motifCounts.entries()]
    .filter(([, count]) => count > threshold)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([motif, count]) => ({ motif, count }));
  const measured = {
    motif_counts: Object.fromEntries([...motifCounts.entries()].sort((a, b) => a[0].localeCompare(b[0]))),
    overused_motifs: overused,
    unresolved_clip_ids: unresolvedClipIds.sort(),
  };
  const finiteThreshold = Number.isFinite(threshold) ? threshold : null;

  return check(id, "plane_2d", overused.length > 0 ? "fail" : "pass", measured as JsonValue, {
    motif_reuse_max: finiteThreshold,
    allow_intentional_repetition: intentionalRepetition,
    longform_continuity_allowed: longformReduction,
  }, overused.length > 0
    ? overused.map((item) =>
        `motif "${item.motif}" appears ${item.count} times, above max ${finiteThreshold}`,
      )
    : [`No selected motif exceeds reuse max ${finiteThreshold ?? "unbounded"}.`]);
}

function checkSpeechCut(input: ReviewMetricsInputs): ReviewMetricCheck {
  const id: ReviewMetricId = "audio.speech_cut";
  if (!input.timeline) return skipped(id, "audio", "timeline.json is missing.");
  const transcriptMap = buildTranscriptMap(input.transcripts ?? []);
  if (transcriptMap.size === 0) {
    return skipped(id, "audio", "No transcript artifacts found.");
  }

  const clipsToCheck = getAudibleSpeechClips(input.timeline, transcriptMap);
  const violations: Array<{
    clip_id: string;
    asset_id: string;
    utterance_start_us: number;
    utterance_end_us: number;
    cut_boundary: "in" | "out";
  }> = [];

  for (const clip of clipsToCheck) {
    const utterances = transcriptMap.get(clip.asset_id) ?? [];
    for (const utterance of utterances) {
      if (!rangesOverlapUs(clip.src_in_us, clip.src_out_us, utterance.start_us, utterance.end_us)) {
        continue;
      }
      if (
        isBoundaryInsideUtterance(clip.src_in_us, utterance, DEFAULT_SPEECH_CUT_GUARD_US) &&
        !isExactUtteranceEdge(clip.src_in_us, utterances)
      ) {
        violations.push({
          clip_id: clip.clip_id,
          asset_id: clip.asset_id,
          utterance_start_us: utterance.start_us,
          utterance_end_us: utterance.end_us,
          cut_boundary: "in",
        });
      }
      if (
        isBoundaryInsideUtterance(clip.src_out_us, utterance, DEFAULT_SPEECH_CUT_GUARD_US) &&
        !isExactUtteranceEdge(clip.src_out_us, utterances)
      ) {
        violations.push({
          clip_id: clip.clip_id,
          asset_id: clip.asset_id,
          utterance_start_us: utterance.start_us,
          utterance_end_us: utterance.end_us,
          cut_boundary: "out",
        });
      }
    }
  }

  return check(id, "audio", violations.length > 0 ? "fail" : "pass", {
    checked_clip_count: clipsToCheck.length,
    speech_cut_violations: violations,
  }, {
    speech_cut_guard_us: DEFAULT_SPEECH_CUT_GUARD_US,
  }, violations.length > 0
    ? violations.map((item) =>
        `${item.clip_id}: ${item.cut_boundary} boundary cuts inside utterance ${item.asset_id}:${item.utterance_start_us}-${item.utterance_end_us}us`,
      )
    : [`No clip boundary cuts through transcript utterances (checked ${clipsToCheck.length} clips).`]);
}

function checkDialogueCompleteness(input: ReviewMetricsInputs): ReviewMetricCheck {
  const id: ReviewMetricId = "story.dialogue_completeness";
  if (!input.timeline) return skipped(id, "story", "timeline.json is missing.");
  const transcriptMap = buildTranscriptMap(input.transcripts ?? []);
  if (transcriptMap.size === 0) {
    return skipped(id, "story", "No transcript artifacts found.");
  }

  const clipsToCheck = getAudibleSpeechClips(input.timeline, transcriptMap);
  const findings = clipsToCheck.flatMap((clip) => {
    const text = (transcriptMap.get(clip.asset_id) ?? [])
      .filter((item) => rangesOverlapUs(clip.src_in_us, clip.src_out_us, item.start_us, item.end_us))
      .map((item) => item.text?.trim() ?? "")
      .filter(Boolean)
      .join(" ");
    if (!text) return [];
    const assessment = assessDialogueCompleteness(text);
    return assessment.issues.map((item) => ({
      clip_id: clip.clip_id,
      asset_id: clip.asset_id,
      boundary: item.boundary,
      code: item.code,
      severity: item.severity,
      excerpt: item.excerpt,
    }));
  });
  const hardFindings = findings.filter((item) => item.severity === "hard");
  const softFindings = findings.filter((item) => item.severity === "soft");
  const status: ReviewMetricStatus = hardFindings.length > 0
    ? "fail"
    : softFindings.length > 0
      ? "warn"
      : "pass";

  return check(id, "story", status, {
    checked_clip_count: clipsToCheck.length,
    hard_issue_count: hardFindings.length,
    soft_issue_count: softFindings.length,
    findings,
  }, {
    hard_issue_max: 0,
    soft_issue_review_required: true,
    scope: "audible transcript clips",
  }, findings.length > 0
    ? findings.map((item) =>
        `${item.clip_id}: ${item.severity} ${item.boundary} ${item.code} — ${item.excerpt}`,
      )
    : [`All ${clipsToCheck.length} audible transcript clips form self-contained assertions.`]);
}

interface BeatWindow {
  beatId: string;
  targetFrames: number;
  actualFrames: number;
  startFrame: number;
  endFrame: number;
}

function resolveBeatWindows(timeline: TimelineIR, blueprint: EditBlueprint): BeatWindow[] {
  const markerByBeat = beatMarkerMap(timeline);
  const maxTimelineEnd = getAllClips(timeline).reduce(
    (max, clip) => Math.max(max, clip.timeline_in_frame + clip.timeline_duration_frames),
    0,
  );
  const windows: BeatWindow[] = [];

  for (let i = 0; i < blueprint.beats.length; i++) {
    const beat = blueprint.beats[i];
    const markerFrame = markerByBeat.get(beat.id);
    const nextMarkerFrame = blueprint.beats
      .slice(i + 1)
      .map((nextBeat) => markerByBeat.get(nextBeat.id))
      .find((frame): frame is number => typeof frame === "number");

    if (typeof markerFrame === "number") {
      const endFrame = typeof nextMarkerFrame === "number"
        ? nextMarkerFrame
        : Math.max(maxTimelineEnd, markerFrame);
      windows.push({
        beatId: beat.id,
        targetFrames: beat.target_duration_frames,
        actualFrames: Math.max(0, endFrame - markerFrame),
        startFrame: markerFrame,
        endFrame,
      });
      continue;
    }

    const beatClips = getAllClips(timeline).filter((clip) => clip.beat_id === beat.id);
    if (beatClips.length === 0) {
      windows.push({
        beatId: beat.id,
        targetFrames: beat.target_duration_frames,
        actualFrames: 0,
        startFrame: 0,
        endFrame: 0,
      });
      continue;
    }

    const startFrame = Math.min(...beatClips.map((clip) => clip.timeline_in_frame));
    const endFrame = Math.max(...beatClips.map((clip) =>
      clip.timeline_in_frame + clip.timeline_duration_frames,
    ));
    windows.push({
      beatId: beat.id,
      targetFrames: beat.target_duration_frames,
      actualFrames: Math.max(0, endFrame - startFrame),
      startFrame,
      endFrame,
    });
  }

  return windows;
}

function resolveHookWindow(timeline: TimelineIR, blueprint: EditBlueprint | undefined): {
  startFrame: number;
  endFrame: number;
} {
  if (!blueprint) {
    const fps = timeline.sequence?.fps_num ?? 24;
    return { startFrame: 0, endFrame: fps * 5 };
  }
  const windows = resolveBeatWindows(timeline, blueprint);
  const hookBeat = blueprint.beats.find((beat) =>
    beat.story_role === "hook" || beat.label.toLowerCase().includes("hook"),
  ) ?? blueprint.beats[0];
  const window = windows.find((item) => item.beatId === hookBeat.id);
  if (window && window.endFrame > window.startFrame) {
    return { startFrame: window.startFrame, endFrame: window.endFrame };
  }
  return {
    startFrame: 0,
    endFrame: hookBeat.target_duration_frames,
  };
}

function beatMarkerMap(timeline: TimelineIR): Map<string, number> {
  const map = new Map<string, number>();
  for (const marker of timeline.markers ?? []) {
    if (marker.kind !== "beat") continue;
    const beatId = marker.label.split(":")[0]?.trim().split(/\s+/)[0];
    if (beatId) map.set(beatId, marker.frame);
  }
  return map;
}

function assignBeatSections(blueprint: EditBlueprint): Map<string, "opening" | "middle" | "ending"> {
  const map = new Map<string, "opening" | "middle" | "ending">();
  const count = blueprint.beats.length;
  for (let i = 0; i < count; i++) {
    const beat = blueprint.beats[i];
    const explicit = beat.story_role === "hook"
      ? "opening"
      : beat.story_role === "closing"
        ? "ending"
        : undefined;
    if (explicit) {
      map.set(beat.id, explicit);
    } else if (i === 0) {
      map.set(beat.id, "opening");
    } else if (i === count - 1) {
      map.set(beat.id, "ending");
    } else {
      map.set(beat.id, "middle");
    }
  }
  return map;
}

function cadenceRank(label: string): number {
  const normalized = label.toLowerCase();
  if (/(余韻|呼吸|自然に閉じ|ゆっくり|間を|落ち着|穏やか)/.test(normalized)) {
    return 3;
  }
  if (/(すぐ|前置き.*置かない|テンポよく|短く|素早く)/.test(normalized)) {
    return 1;
  }
  if (/(brisk|fast|quick|tight|urgent|short|montage|rapid|high)/.test(normalized)) {
    return 1;
  }
  if (/(spacious|slow|warm|breathe|breath|held|reflective|calm|measured|gentle)/.test(normalized)) {
    return 3;
  }
  return 2;
}

function compareCadencePair(
  leftName: "opening" | "middle" | "ending",
  rightName: "opening" | "middle" | "ending",
  leftRank: number,
  rightRank: number,
  leftAverage: number,
  rightAverage: number,
): string | null {
  if (leftRank === rightRank) return null;
  const toleranceFactor = CADENCE_COMPARISON_TOLERANCE_PCT / 100;
  if (rightRank > leftRank && rightAverage < leftAverage * (1 - toleranceFactor)) {
    return `${rightName}: average ${rightAverage}f should not be shorter than ${leftName} ${leftAverage}f under cadence policy`;
  }
  if (rightRank < leftRank && rightAverage > leftAverage * (1 + toleranceFactor)) {
    return `${rightName}: average ${rightAverage}f should not be longer than ${leftName} ${leftAverage}f under cadence policy`;
  }
  return null;
}

function getVideoClips(timeline: TimelineIR): TimelineClip[] {
  return ((timeline.tracks?.video ?? [])
    .flatMap((track) => track.clips ?? [])
    .slice() as TimelineClip[])
    .sort(compareClipOrder);
}

function getAllClips(timeline: TimelineIR): TimelineClip[] {
  return ([
    ...(timeline.tracks?.video ?? []).flatMap((track) => track.clips ?? []),
    ...(timeline.tracks?.audio ?? []).flatMap((track) => track.clips ?? []),
  ].slice() as TimelineClip[]).sort(compareClipOrder);
}

function getAudibleSpeechClips(
  timeline: TimelineIR,
  transcriptMap: Map<string, TranscriptItem[]>,
): TimelineClip[] {
  const audioClips = ((timeline.tracks?.audio ?? [])
    .flatMap((track) => track.clips ?? [])
    .slice() as TimelineClip[])
    .filter((clip) => clip.role === "dialogue" || transcriptMap.has(clip.asset_id));
  if (audioClips.length > 0) return audioClips.sort(compareClipOrder);

  return getVideoClips(timeline).filter((clip) =>
    clip.role === "dialogue" || transcriptMap.has(clip.asset_id),
  );
}

function getV1Clips(timeline: TimelineIR): TimelineClip[] {
  const videoTracks = timeline.tracks?.video ?? [];
  const v1Track = videoTracks.find((track) => track.track_id === "V1") ?? videoTracks[0];
  return ((v1Track?.clips ?? []).slice() as TimelineClip[]).sort(compareClipOrder);
}

function compareClipOrder(a: TimelineClip, b: TimelineClip): number {
  return a.timeline_in_frame - b.timeline_in_frame ||
    a.clip_id.localeCompare(b.clip_id);
}

function buildCandidateMap(selects: SelectsArtifact | undefined): Map<string, Candidate> {
  const map = new Map<string, Candidate>();
  for (const candidate of selects?.candidates ?? []) {
    map.set(candidate.segment_id, candidate);
    if (candidate.candidate_id) map.set(candidate.candidate_id, candidate);
    const legacyRef = `legacy:${candidate.segment_id}:${candidate.src_in_us}:${candidate.src_out_us}`;
    map.set(legacyRef, candidate);
  }
  return map;
}

function candidateForClip(
  clip: TimelineClip,
  candidateMap: Map<string, Candidate>,
): Candidate | undefined {
  if (clip.candidate_ref && candidateMap.has(clip.candidate_ref)) {
    return candidateMap.get(clip.candidate_ref);
  }
  if (candidateMap.has(clip.segment_id)) return candidateMap.get(clip.segment_id);
  if (clip.candidate_ref) {
    const match = clip.candidate_ref.match(/^legacy:([^:]+):/);
    if (match) return candidateMap.get(match[1]);
  }
  return undefined;
}

function buildSegmentMap(segments: SegmentsArtifact): Map<string, SegmentItem> {
  const map = new Map<string, SegmentItem>();
  for (const item of segments.items ?? []) {
    map.set(item.segment_id, item);
  }
  return map;
}

interface SelectedPeakWindow {
  segmentId: string;
  sourceInUs: number;
  sourceOutUs: number;
  clips: TimelineClip[];
}

function buildSelectedPeakWindows(
  clips: TimelineClip[],
  candidateMap: Map<string, Candidate>,
): SelectedPeakWindow[] {
  const windows = new Map<string, SelectedPeakWindow>();
  for (const clip of clips) {
    const candidate = candidateForClip(clip, candidateMap);
    const sourceInUs = candidate?.src_in_us ?? clip.src_in_us;
    const sourceOutUs = candidate?.src_out_us ?? clip.src_out_us;
    if (sourceOutUs <= sourceInUs) continue;
    const key = `${clip.segment_id}:${sourceInUs}:${sourceOutUs}`;
    const current = windows.get(key);
    if (current) {
      current.clips.push(clip);
    } else {
      windows.set(key, {
        segmentId: clip.segment_id,
        sourceInUs,
        sourceOutUs,
        clips: [clip],
      });
    }
  }

  return [...windows.values()].sort((a, b) =>
    a.segmentId.localeCompare(b.segmentId) ||
    a.sourceInUs - b.sourceInUs ||
    a.sourceOutUs - b.sourceOutUs,
  );
}

function strongPeaksForSegment(
  segment: SegmentItem | undefined,
  confidenceThreshold: number,
): PeakMoment[] {
  return (segment?.peak_analysis?.peak_moments ?? [])
    .filter((peak) => peak.confidence >= confidenceThreshold)
    .slice()
    .sort((a, b) => a.timestamp_us - b.timestamp_us || a.peak_ref.localeCompare(b.peak_ref));
}

function hasPeakSignalSource(
  clip: TimelineClip,
  candidateMap: Map<string, Candidate>,
  segmentMap: Map<string, SegmentItem>,
): boolean {
  if (clipMetadataHasPeakSignalSource(clip)) return true;

  const candidate = candidateForClip(clip, candidateMap);
  if (
    candidate?.editorial_signals?.peak_strength_score !== undefined ||
    candidate?.editorial_signals?.speech_intensity_score !== undefined ||
    candidate?.editorial_signals?.reaction_intensity_score !== undefined ||
    candidate?.editorial_signals?.surprise_signal !== undefined ||
    candidate?.peak_signals !== undefined ||
    candidate?.trim_hint?.interest_point_confidence !== undefined ||
    candidate?.trim_hint?.peak_ref !== undefined ||
    candidate?.trim_hint?.peak_type !== undefined
  ) {
    return true;
  }
  return (segmentMap.get(clip.segment_id)?.peak_analysis?.peak_moments?.length ?? 0) > 0;
}

function clipHasRetainedPeakSignal(
  clip: TimelineClip,
  candidateMap: Map<string, Candidate>,
  segmentMap: Map<string, SegmentItem>,
): boolean {
  const candidate = candidateForClip(clip, candidateMap);
  const strongestCandidateSignal = strongestPeakSignalForClip(clip, candidate);
  if (strongestCandidateSignal >= DEFAULT_STRONG_PEAK_CONFIDENCE_MIN) return true;

  return strongPeaksForSegment(
    segmentMap.get(clip.segment_id),
    DEFAULT_STRONG_PEAK_CONFIDENCE_MIN,
  ).some((peak) => peak.timestamp_us >= clip.src_in_us && peak.timestamp_us <= clip.src_out_us);
}

function strongestPeakSignalForClip(
  clip: TimelineClip,
  candidate: Candidate | undefined,
): number {
  const peakSignals = candidate?.peak_signals;
  return Math.max(
    candidate?.editorial_signals?.peak_strength_score ?? 0,
    candidate?.editorial_signals?.speech_intensity_score ?? 0,
    candidate?.editorial_signals?.reaction_intensity_score ?? 0,
    candidate?.editorial_signals?.surprise_signal ?? 0,
    candidate?.trim_hint?.interest_point_confidence ?? 0,
    peakSignals?.motion ?? 0,
    peakSignals?.audio_rms ?? 0,
    Math.min(1, (peakSignals?.speech_keyword?.length ?? 0) / 3),
    clipMetadataPeakSignalScore(clip),
  );
}

function clipMetadataHasPeakSignalSource(clip: TimelineClip): boolean {
  const metadata = recordValue(clip.metadata);
  if (!metadata) return false;
  if (recordValue(metadata.peak_signals)) return true;

  const trim = recordValue(metadata.trim);
  if (
    trim?.peak_confidence !== undefined ||
    trim?.interest_point_confidence !== undefined ||
    trim?.peak_ref !== undefined ||
    trim?.peak_type !== undefined
  ) {
    return true;
  }

  const editorial = recordValue(metadata.editorial);
  const peak = recordValue(editorial?.peak);
  return Boolean(
    peak?.peak_confidence !== undefined ||
    peak?.primary_peak_ref !== undefined ||
    peak?.peak_ref !== undefined ||
    peak?.peak_type !== undefined,
  );
}

function clipMetadataPeakSignalScore(clip: TimelineClip): number {
  const metadata = recordValue(clip.metadata);
  if (!metadata) return 0;

  const peakSignals = recordValue(metadata.peak_signals);
  const trim = recordValue(metadata.trim);
  const editorial = recordValue(metadata.editorial);
  const peak = recordValue(editorial?.peak);
  const speechKeywords = Array.isArray(peakSignals?.speech_keyword)
    ? Math.min(1, peakSignals.speech_keyword.length / 3)
    : 0;

  return Math.max(
    numberValue(peakSignals?.motion),
    numberValue(peakSignals?.audio_rms),
    speechKeywords,
    numberValue(trim?.peak_confidence),
    numberValue(trim?.interest_point_confidence),
    numberValue(peak?.peak_confidence),
  );
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function buildTranscriptMap(transcripts: TranscriptArtifact[]): Map<string, TranscriptItem[]> {
  const map = new Map<string, TranscriptItem[]>();
  for (const transcript of transcripts) {
    const items = (transcript.items ?? [])
      .filter((item) => item.end_us > item.start_us)
      .slice()
      .sort((a, b) => a.start_us - b.start_us || a.end_us - b.end_us);
    if (items.length > 0) map.set(transcript.asset_id, items);
  }
  return map;
}

function isBoundaryInsideUtterance(
  boundaryUs: number,
  utterance: TranscriptItem,
  guardUs: number,
): boolean {
  return boundaryUs > utterance.start_us + guardUs &&
    boundaryUs < utterance.end_us - guardUs;
}

function isExactUtteranceEdge(boundaryUs: number, utterances: TranscriptItem[]): boolean {
  return utterances.some((utterance) =>
    boundaryUs === utterance.start_us || boundaryUs === utterance.end_us,
  );
}

function rangesOverlapFrames(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

function rangesOverlapUs(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

function pointInUsRange(value: number, start: number, end: number): boolean {
  return value >= start && value <= end;
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
