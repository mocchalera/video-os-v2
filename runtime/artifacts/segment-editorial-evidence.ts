import * as fs from "node:fs";
import * as path from "node:path";
import type {
  AdjacencyFeatures,
  CameraAxis,
  CompositionAnchor,
  EvidenceCoverageStatus,
  GazeDirection,
  MotionType,
  SegmentEvidenceConfidence,
  SegmentEvidenceConfidenceGroup,
  SegmentEvidenceCoverage,
  ShotScale,
  ScreenSide,
} from "../compiler/transition-types.js";

export interface SegmentEvidence {
  adjacency_features: AdjacencyFeatures;
  coverage?: SegmentEvidenceCoverage;
  confidence?: Partial<Record<SegmentEvidenceConfidenceGroup, SegmentEvidenceConfidence>>;
  peak_moments?: Array<{
    peak_ref?: string;
    timestamp_us?: number;
    type?: string;
    confidence?: number;
    description?: string;
    source_pass?: string;
  }>;
  support_signals?: {
    fused_peak_score?: number;
    motion_support_score?: number;
    audio_support_score?: number;
  };
}

type Diagnostic = (message: string) => void;
type UnknownRecord = Record<string, unknown>;

const COVERAGE_FIELDS = [
  "visual_tags",
  "motion_type",
  "shot_scale",
  "composition_anchor",
  "screen_side",
  "gaze_direction",
  "camera_axis",
  "camera_motion_direction",
  "subject_motion_direction",
  "dominant_subject_type",
  "avg_luma",
  "dominant_colors",
  "text_presence",
] as const;

const CONFIDENCE_GROUPS = ["tags", "motion", "framing", "direction", "appearance", "text"] as const;

const MOTION_TYPES = new Set<MotionType>(["static", "subtle", "continuous", "intermittent", "rapid", "mixed", "unknown", "not_applicable"]);
const SHOT_SCALES = new Set<ShotScale>(["extreme_wide", "wide", "medium_wide", "medium", "medium_close_up", "close_up", "extreme_close_up", "insert", "unknown", "not_applicable"]);
const COMPOSITION_ANCHORS = new Set<CompositionAnchor>(["left", "center", "right", "balanced", "multiple", "full_frame", "unknown", "not_applicable"]);
const SCREEN_SIDES = new Set<ScreenSide>(["left", "center", "right", "multiple", "full_frame", "unknown", "not_applicable"]);
const GAZE_DIRECTIONS = new Set<GazeDirection>(["screen_left", "screen_right", "camera", "away", "up", "down", "mixed", "unknown", "not_applicable"]);
const CAMERA_AXES = new Set<CameraAxis>(["axis_left", "axis_right", "on_axis", "establishing", "unknown", "not_applicable"]);
const MOTION_DIRECTIONS = new Set<NonNullable<AdjacencyFeatures["camera_motion_direction"]>>(["left", "right", "up", "down", "toward_camera", "away_from_camera", "mixed", "unknown", "not_applicable"]);
const SUBJECT_TYPES = new Set<NonNullable<AdjacencyFeatures["dominant_subject_type"]>>(["person", "group", "animal", "object", "landscape", "architecture", "text_graphic", "mixed", "unknown", "not_applicable"]);
const TEXT_PRESENCE = new Set<NonNullable<AdjacencyFeatures["text_presence"]>>(["present", "absent", "unknown", "not_applicable"]);

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? [...value]
    : undefined;
}

function enumValue<T extends string>(value: unknown, allowed: Set<T>): T | undefined {
  return typeof value === "string" && allowed.has(value as T) ? value as T : undefined;
}

function coverageStatus(value: unknown, valid: boolean): EvidenceCoverageStatus {
  if (value === "unknown") return "unknown";
  if (value === "not_applicable") return "not_applicable";
  return valid ? "known" : "missing";
}

function emptyCoverage(): SegmentEvidenceCoverage {
  return Object.fromEntries(COVERAGE_FIELDS.map((field) => [field, "missing"])) as SegmentEvidenceCoverage;
}

function finiteScore(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : undefined;
}

function copyObservationConfidence(
  value: unknown,
): SegmentEvidence["confidence"] {
  if (!isRecord(value)) return undefined;
  const result: Partial<Record<SegmentEvidenceConfidenceGroup, SegmentEvidenceConfidence>> = {};
  for (const group of CONFIDENCE_GROUPS) {
    const raw = value[group];
    const record = isRecord(raw) ? raw : undefined;
    const score = finiteScore(record?.score ?? raw);
    if (score === undefined) continue;
    result[group] = {
      score,
      evidence_refs: stringArray(record?.evidence_refs) ?? [],
    };
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function copyPeakMoments(value: unknown): SegmentEvidence["peak_moments"] {
  if (!Array.isArray(value)) return undefined;
  return value.filter(isRecord).map((moment) => ({
    ...(typeof moment.peak_ref === "string" ? { peak_ref: moment.peak_ref } : {}),
    ...(typeof moment.timestamp_us === "number" && Number.isFinite(moment.timestamp_us) ? { timestamp_us: moment.timestamp_us } : {}),
    ...(typeof moment.type === "string" ? { type: moment.type } : {}),
    ...(typeof moment.confidence === "number" && Number.isFinite(moment.confidence) ? { confidence: moment.confidence } : {}),
    ...(typeof moment.description === "string" ? { description: moment.description } : {}),
    ...(typeof moment.source_pass === "string" ? { source_pass: moment.source_pass } : {}),
  }));
}

function copySupportSignals(value: unknown): SegmentEvidence["support_signals"] {
  if (!isRecord(value)) return undefined;
  const result = {
    fused_peak_score: finiteScore(value.fused_peak_score),
    motion_support_score: finiteScore(value.motion_support_score),
    audio_support_score: finiteScore(value.audio_support_score),
  };
  return Object.values(result).some((item) => item !== undefined) ? result : undefined;
}

/** Pure adapter for canonical segments.json data. It never mutates its input. */
export function adaptSegmentEditorialEvidence(
  document: unknown,
  diagnostic?: Diagnostic,
): Map<string, SegmentEvidence> {
  const result = new Map<string, SegmentEvidence>();
  if (!isRecord(document) || !Array.isArray(document.items)) {
    diagnostic?.("[editorial-eye] malformed 03_analysis/segments.json: expected an items array; continuing without segment evidence");
    return result;
  }

  for (const [index, rawItem] of document.items.entries()) {
    if (!isRecord(rawItem) || typeof rawItem.segment_id !== "string" || rawItem.segment_id.length === 0) {
      diagnostic?.(`[editorial-eye] ignored malformed segments.json item at index ${index}`);
      continue;
    }
    if (result.has(rawItem.segment_id)) {
      diagnostic?.(`[editorial-eye] ignored duplicate segment_id ${rawItem.segment_id}`);
      continue;
    }

    const observation = isRecord(rawItem.editorial_observation) ? rawItem.editorial_observation : undefined;
    const coverage = emptyCoverage();
    const adjacency: AdjacencyFeatures = { visual_tags: [], motion_type: "unknown" };
    let confidence: SegmentEvidence["confidence"];

    if (observation) {
      confidence = copyObservationConfidence(observation.confidence);
      const tags = stringArray(observation.visual_tags);
      if (tags) adjacency.visual_tags = tags;
      coverage.visual_tags = coverageStatus(observation.visual_tags, tags !== undefined);

      const motion = enumValue(observation.motion_type, MOTION_TYPES);
      if (motion) adjacency.motion_type = motion;
      coverage.motion_type = coverageStatus(observation.motion_type, motion !== undefined);

      const shotScale = enumValue(observation.shot_scale, SHOT_SCALES);
      if (shotScale) adjacency.shot_scale = shotScale;
      coverage.shot_scale = coverageStatus(observation.shot_scale, shotScale !== undefined);

      const compositionAnchor = enumValue(observation.composition_anchor, COMPOSITION_ANCHORS);
      if (compositionAnchor) adjacency.composition_anchor = compositionAnchor;
      coverage.composition_anchor = coverageStatus(observation.composition_anchor, compositionAnchor !== undefined);

      const screenSide = enumValue(observation.screen_side, SCREEN_SIDES);
      if (screenSide) adjacency.screen_side = screenSide;
      coverage.screen_side = coverageStatus(observation.screen_side, screenSide !== undefined);

      const gazeDirection = enumValue(observation.gaze_direction, GAZE_DIRECTIONS);
      if (gazeDirection) adjacency.gaze_direction = gazeDirection;
      coverage.gaze_direction = coverageStatus(observation.gaze_direction, gazeDirection !== undefined);

      const cameraAxis = enumValue(observation.camera_axis, CAMERA_AXES);
      if (cameraAxis) adjacency.camera_axis = cameraAxis;
      coverage.camera_axis = coverageStatus(observation.camera_axis, cameraAxis !== undefined);

      const cameraMotion = enumValue(observation.camera_motion_direction, MOTION_DIRECTIONS);
      if (cameraMotion) adjacency.camera_motion_direction = cameraMotion;
      coverage.camera_motion_direction = coverageStatus(observation.camera_motion_direction, cameraMotion !== undefined);
      const subjectMotion = enumValue(observation.subject_motion_direction, MOTION_DIRECTIONS);
      if (subjectMotion) adjacency.subject_motion_direction = subjectMotion;
      coverage.subject_motion_direction = coverageStatus(observation.subject_motion_direction, subjectMotion !== undefined);
      const subjectType = enumValue(observation.dominant_subject_type, SUBJECT_TYPES);
      if (subjectType) adjacency.dominant_subject_type = subjectType;
      coverage.dominant_subject_type = coverageStatus(observation.dominant_subject_type, subjectType !== undefined);
      const avgLuma = finiteScore(observation.avg_luma);
      if (avgLuma !== undefined) adjacency.avg_luma = avgLuma;
      coverage.avg_luma = coverageStatus(observation.avg_luma, avgLuma !== undefined);
      const colors = stringArray(observation.dominant_colors);
      if (colors) adjacency.dominant_colors = colors;
      coverage.dominant_colors = coverageStatus(observation.dominant_colors, colors !== undefined);
      const textPresence = enumValue(observation.text_presence, TEXT_PRESENCE);
      if (textPresence) adjacency.text_presence = textPresence;
      coverage.text_presence = coverageStatus(observation.text_presence, textPresence !== undefined);
    } else {
      const legacyTags = stringArray(rawItem.tags);
      if (legacyTags) adjacency.visual_tags = legacyTags;
      coverage.visual_tags = legacyTags ? "known" : "missing";
      coverage.motion_type = "unknown";
    }

    const peakAnalysis = isRecord(rawItem.peak_analysis) ? rawItem.peak_analysis : undefined;
    const peakMoments = copyPeakMoments(peakAnalysis?.peak_moments);
    const supportSignals = copySupportSignals(peakAnalysis?.support_signals);
    result.set(rawItem.segment_id, {
      adjacency_features: adjacency,
      coverage,
      ...(confidence ? { confidence } : {}),
      ...(peakMoments ? { peak_moments: peakMoments } : {}),
      ...(supportSignals ? { support_signals: supportSignals } : {}),
    });
  }

  return result;
}

/** Deterministic, fail-open loader. This is the only filesystem boundary in the adapter. */
export function loadSegmentEditorialEvidence(
  projectPath: string,
  diagnostic?: Diagnostic,
): Map<string, SegmentEvidence> {
  const segmentsPath = path.join(projectPath, "03_analysis", "segments.json");
  let raw: string;
  try {
    raw = fs.readFileSync(segmentsPath, "utf-8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    diagnostic?.(`[editorial-eye] unavailable ${segmentsPath}: ${detail}; continuing without segment evidence`);
    return new Map();
  }
  try {
    return adaptSegmentEditorialEvidence(JSON.parse(raw), diagnostic);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    diagnostic?.(`[editorial-eye] malformed ${segmentsPath}: ${detail}; continuing without segment evidence`);
    return new Map();
  }
}
