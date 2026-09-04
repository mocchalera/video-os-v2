import type { VisualQualityMeasurements } from "../../connectors/ffmpeg-motion.js";

export const EDITORIAL_OBSERVATION_VERSION = "editorial-observation-v1";

export type ObservationStatus = "ready" | "partial" | "skipped";
export type MotionType = "static" | "subtle" | "continuous" | "intermittent" | "rapid" | "mixed" | "unknown" | "not_applicable";
export type MotionDirection = "left" | "right" | "up" | "down" | "toward_camera" | "away_from_camera" | "mixed" | "unknown" | "not_applicable";
export type ShotScale = "extreme_wide" | "wide" | "medium_wide" | "medium" | "medium_close_up" | "close_up" | "extreme_close_up" | "insert" | "unknown" | "not_applicable";
export type CompositionAnchor = "left" | "center" | "right" | "balanced" | "multiple" | "full_frame" | "unknown" | "not_applicable";
export type ScreenSide = "left" | "center" | "right" | "multiple" | "full_frame" | "unknown" | "not_applicable";
export type GazeDirection = "screen_left" | "screen_right" | "camera" | "away" | "up" | "down" | "mixed" | "unknown" | "not_applicable";
export type CameraAxis = "axis_left" | "axis_right" | "on_axis" | "establishing" | "unknown" | "not_applicable";
export type DominantSubjectType = "person" | "group" | "animal" | "object" | "landscape" | "architecture" | "text_graphic" | "mixed" | "unknown" | "not_applicable";
export type TextPresence = "present" | "absent" | "unknown" | "not_applicable";
export type ObservationConfidenceGroup = "tags" | "motion" | "framing" | "direction" | "appearance" | "text";
export type ObservationField =
  | "visual_tags" | "motion_type" | "camera_motion_direction" | "subject_motion_direction"
  | "shot_scale" | "composition_anchor" | "screen_side" | "gaze_direction" | "camera_axis"
  | "dominant_subject_type" | "avg_luma" | "dominant_colors" | "text_presence";

export interface ObservationEvidence {
  evidence_ref: string;
  producer: ObservationProducerKind;
  evidence_type: "verified_frame" | "deterministic_measurement" | "appraiser_frame" | "producer_gap" | "applicability";
  fields: ObservationField[];
  artifact_ref?: string;
  frame_us?: number;
  observed_value?: string | number | string[];
  warning?: string;
}

export type ObservationProducerKind = "grounded_vlm" | "deterministic_measurement" | "appraiser" | "media_kind_router";

export interface ObservationProducerProvenance {
  producer: ObservationProducerKind;
  producer_version: string;
  model?: string;
  runtime?: string;
  prompt_hash?: string;
  actual_verified_frame_count: number;
  evidence_refs: string[];
  source_content_sha256?: string;
  cache_identity?: string;
  cache_decision?: string;
}

export interface ObservationGroupConfidence {
  score: number;
  evidence_refs: string[];
}

export interface EditorialObservation {
  status: ObservationStatus;
  visual_tags?: string[];
  motion_type?: MotionType;
  camera_motion_direction?: MotionDirection;
  subject_motion_direction?: MotionDirection;
  shot_scale?: ShotScale;
  composition_anchor?: CompositionAnchor;
  screen_side?: ScreenSide;
  gaze_direction?: GazeDirection;
  camera_axis?: CameraAxis;
  dominant_subject_type?: DominantSubjectType;
  avg_luma?: number;
  dominant_colors?: string[];
  text_presence?: TextPresence;
  confidence: Partial<Record<ObservationConfidenceGroup, ObservationGroupConfidence>>;
  evidence: ObservationEvidence[];
  warnings: string[];
  producer_snapshots?: Partial<Record<ObservationProducerKind, ObservationContribution>>;
  provenance: {
    contract_version: string;
    asset_id: string;
    segment_id: string;
    segment_src_in_us: number;
    segment_src_out_us: number;
    producers: ObservationProducerProvenance[];
  };
}

export type ObservationValues = Pick<EditorialObservation,
  "visual_tags" | "motion_type" | "camera_motion_direction" | "subject_motion_direction" |
  "shot_scale" | "composition_anchor" | "screen_side" | "gaze_direction" | "camera_axis" |
  "dominant_subject_type" | "avg_luma" | "dominant_colors" | "text_presence"
>;

export interface ObservationContribution {
  status: ObservationStatus;
  values?: ObservationValues;
  confidence?: Partial<Record<ObservationConfidenceGroup, ObservationGroupConfidence>>;
  evidence: ObservationEvidence[];
  warnings?: string[];
  producer: ObservationProducerProvenance;
}

export interface ObservationSegmentIdentity {
  asset_id: string;
  segment_id: string;
  src_in_us: number;
  src_out_us: number;
}

const FIELD_GROUP: Record<ObservationField, ObservationConfidenceGroup> = {
  visual_tags: "tags",
  motion_type: "motion",
  camera_motion_direction: "direction",
  subject_motion_direction: "direction",
  shot_scale: "framing",
  composition_anchor: "framing",
  screen_side: "framing",
  gaze_direction: "direction",
  camera_axis: "direction",
  dominant_subject_type: "appearance",
  avg_luma: "appearance",
  dominant_colors: "appearance",
  text_presence: "text",
};

const PRODUCER_PRIORITY: Record<ObservationProducerKind, number> = {
  deterministic_measurement: 3,
  grounded_vlm: 2,
  appraiser: 1,
  media_kind_router: 4,
};

export function stillImageApplicabilityContribution(segment: ObservationSegmentIdentity): ObservationContribution {
  const fields: ObservationField[] = [
    "motion_type",
    "camera_motion_direction",
    "subject_motion_direction",
  ];
  const evidenceRef = `media-kind:${segment.segment_id}:still-image-applicability-v1`;
  return {
    status: "partial",
    values: {
      motion_type: "not_applicable",
      camera_motion_direction: "not_applicable",
      subject_motion_direction: "not_applicable",
    },
    evidence: [{
      evidence_ref: evidenceRef,
      producer: "media_kind_router",
      evidence_type: "applicability",
      fields,
      observed_value: "media_kind=image",
    }],
    producer: {
      producer: "media_kind_router",
      producer_version: "still-image-applicability-v1",
      runtime: "deterministic_media_kind_router",
      actual_verified_frame_count: 0,
      evidence_refs: [evidenceRef],
    },
  };
}

export function reduceEditorialObservation(
  identity: ObservationSegmentIdentity,
  current: EditorialObservation | undefined,
  contributions: ObservationContribution[],
): EditorialObservation {
  const snapshots = current?.producer_snapshots
    ? structuredClone(current.producer_snapshots)
    : {};
  for (const contribution of contributions) {
    snapshots[contribution.producer.producer] = structuredClone(contribution);
  }
  return materializeObservation(identity, snapshots);
}

export function removeEditorialObservationProducer(
  current: EditorialObservation | undefined,
  producer: ObservationProducerKind,
): EditorialObservation | undefined {
  if (!current) return undefined;
  if (!current.producer_snapshots) return undefined;
  const snapshots = structuredClone(current.producer_snapshots);
  delete snapshots[producer];
  if (Object.keys(snapshots).length === 0) return undefined;
  return materializeObservation({
    asset_id: current.provenance.asset_id,
    segment_id: current.provenance.segment_id,
    src_in_us: current.provenance.segment_src_in_us,
    src_out_us: current.provenance.segment_src_out_us,
  }, snapshots);
}

function materializeObservation(
  identity: ObservationSegmentIdentity,
  snapshots: Partial<Record<ObservationProducerKind, ObservationContribution>>,
): EditorialObservation {
  const base = emptyObservation(identity);
  const fieldOwners: Partial<Record<ObservationField, ObservationProducerKind>> = {};
  base.producer_snapshots = structuredClone(snapshots);
  const contributions = Object.values(snapshots)
    .filter((item): item is ObservationContribution => item !== undefined)
    .sort((left, right) =>
      PRODUCER_PRIORITY[left.producer.producer] - PRODUCER_PRIORITY[right.producer.producer]
    );
  for (const contribution of contributions) mergeContribution(base, contribution, fieldOwners);
  base.confidence = materializeConfidence(contributions, fieldOwners);
  base.status = resolveStatus(base, contributions);
  base.warnings = uniqueStrings(base.warnings);
  base.evidence = uniqueEvidence(base.evidence);
  base.provenance.producers = uniqueProducers(base.provenance.producers);
  return base;
}

export function deterministicObservationContribution(options: {
  segment: ObservationSegmentIdentity;
  measurements: VisualQualityMeasurements;
  sourcePath?: string;
  requestHash?: string;
}): ObservationContribution {
  const measurement = options.measurements;
  const values: ObservationValues = {};
  const evidence: ObservationEvidence[] = [];
  const fields: ObservationField[] = [];
  if (measurement.metrics_measured.exposure && measurement.exposure) {
    values.avg_luma = clamp01(measurement.exposure.avg_luma);
    fields.push("avg_luma");
  }
  if (measurement.metrics_measured.shake && measurement.shake) {
    values.motion_type = measuredMotionType(measurement.shake.average_energy);
    fields.push("motion_type");
  }
  const evidenceRef = `measurement:${options.segment.segment_id}:${options.requestHash ?? measurement.connector_version}`;
  if (fields.length > 0) {
    evidence.push({
      evidence_ref: evidenceRef,
      producer: "deterministic_measurement",
      evidence_type: "deterministic_measurement",
      fields,
      ...(options.sourcePath ? { artifact_ref: options.sourcePath } : {}),
      observed_value: fields.map((field) => `${field}=${String(values[field as keyof ObservationValues])}`),
    });
  } else {
    evidence.push({
      evidence_ref: evidenceRef,
      producer: "deterministic_measurement",
      evidence_type: "producer_gap",
      fields: [],
      warning: measurement.failure_reason ?? "deterministic_visual_measurements_unavailable",
    });
  }
  const score = fields.length > 0 ? 1 : 0;
  return {
    status: measurement.measured ? "partial" : fields.length > 0 ? "partial" : "skipped",
    values,
    confidence: {
      ...(fields.includes("motion_type") ? { motion: { score, evidence_refs: [evidenceRef] } } : {}),
      ...(fields.includes("avg_luma") ? { appearance: { score, evidence_refs: [evidenceRef] } } : {}),
    },
    evidence,
    ...(measurement.failure_reason ? { warnings: [`deterministic_measurement_gap:${measurement.failure_reason}`] } : {}),
    producer: {
      producer: "deterministic_measurement",
      producer_version: measurement.connector_version,
      runtime: "ffmpeg",
      actual_verified_frame_count: Math.max(
        measurement.shake?.sample_count ?? 0,
        measurement.sharpness?.sample_count ?? 0,
        measurement.exposure?.sample_count ?? 0,
      ),
      evidence_refs: [evidenceRef],
      ...(options.requestHash ? { cache_identity: options.requestHash } : {}),
    },
  };
}

function emptyObservation(identity: ObservationSegmentIdentity): EditorialObservation {
  return {
    status: "skipped",
    confidence: {},
    evidence: [],
    warnings: [],
    provenance: {
      contract_version: EDITORIAL_OBSERVATION_VERSION,
      asset_id: identity.asset_id,
      segment_id: identity.segment_id,
      segment_src_in_us: identity.src_in_us,
      segment_src_out_us: identity.src_out_us,
      producers: [],
    },
  };
}

function mergeContribution(
  target: EditorialObservation,
  contribution: ObservationContribution,
  fieldOwners: Partial<Record<ObservationField, ObservationProducerKind>>,
): void {
  const values = contribution.values ?? {};
  for (const field of Object.keys(values) as ObservationField[]) {
    const incoming = values[field as keyof ObservationValues];
    if (incoming === undefined) continue;
    const current = target[field as keyof EditorialObservation];
    if (current === undefined) {
      assignObservationField(target, field, incoming);
      fieldOwners[field] = contribution.producer.producer;
      continue;
    }
    const currentProducer = fieldOwners[field];
    const keepIncoming = currentProducer === undefined ||
      PRODUCER_PRIORITY[contribution.producer.producer] > PRODUCER_PRIORITY[currentProducer];
    if (sameValue(current, incoming)) {
      if (keepIncoming) fieldOwners[field] = contribution.producer.producer;
      continue;
    }
    const kept = keepIncoming ? incoming : current;
    const rejected = keepIncoming ? current : incoming;
    target.warnings.push(
      `producer_disagreement:${field}:kept_producer=${keepIncoming ? contribution.producer.producer : currentProducer ?? "unknown"}:kept=${serializeValue(kept)}:` +
      `rejected_producer=${keepIncoming ? currentProducer ?? "unknown" : contribution.producer.producer}:rejected=${serializeValue(rejected)}`,
    );
    if (keepIncoming) {
      assignObservationField(target, field, incoming);
      fieldOwners[field] = contribution.producer.producer;
    }
  }
  target.evidence.push(...contribution.evidence);
  target.warnings.push(...(contribution.warnings ?? []));
  target.provenance.producers.push(contribution.producer);
}

function materializeConfidence(
  contributions: ObservationContribution[],
  fieldOwners: Partial<Record<ObservationField, ObservationProducerKind>>,
): EditorialObservation["confidence"] {
  const contributionByProducer = new Map(
    contributions.map((contribution) => [contribution.producer.producer, contribution]),
  );
  const result: EditorialObservation["confidence"] = {};
  for (const group of ["tags", "motion", "framing", "direction", "appearance", "text"] as const) {
    const owners = uniqueStrings(
      (Object.entries(FIELD_GROUP) as Array<[ObservationField, ObservationConfidenceGroup]>)
        .filter(([field, fieldGroup]) => fieldGroup === group && fieldOwners[field] !== undefined)
        .map(([field]) => fieldOwners[field]!),
    ) as ObservationProducerKind[];
    if (owners.length === 0) continue;
    const ownerConfidences = owners.map((owner) => contributionByProducer.get(owner)?.confidence?.[group]);
    if (ownerConfidences.some((confidence) => confidence === undefined)) continue;
    const groundedConfidences = ownerConfidences as ObservationGroupConfidence[];
    result[group] = {
      score: Math.min(...groundedConfidences.map((confidence) => clamp01(confidence.score))),
      evidence_refs: uniqueStrings(groundedConfidences.flatMap((confidence) => confidence.evidence_refs)),
    };
  }
  return result;
}

function assignObservationField(target: EditorialObservation, field: ObservationField, value: ObservationValues[keyof ObservationValues]): void {
  (target as unknown as Record<string, unknown>)[field] = value;
}

function resolveStatus(observation: EditorialObservation, contributions: ObservationContribution[]): ObservationStatus {
  const hasConcrete = Object.keys(FIELD_GROUP).some((field) => observation[field as keyof EditorialObservation] !== undefined);
  if (!hasConcrete) return "skipped";
  const hasGap = contributions.some((item) => item.status === "skipped") ||
    observation.warnings.some((item) => item.includes("gap"));
  const allFieldsObserved = Object.keys(FIELD_GROUP).every((field) =>
    observation[field as keyof EditorialObservation] !== undefined
  );
  const allGroupsGrounded = (["tags", "motion", "framing", "direction", "appearance", "text"] as const)
    .every((group) => (observation.confidence[group]?.evidence_refs.length ?? 0) > 0 ||
      (observation.provenance.producers.some((producer) => producer.producer === "media_kind_router") &&
        (group === "motion" || group === "direction")));
  const groundedVlmSucceeded = observation.provenance.producers.some((producer) =>
    producer.producer === "grounded_vlm" && producer.actual_verified_frame_count > 0
  );
  const stillGroundingReady = contributions.some((item) => item.producer.producer === "media_kind_router")
    ? hasCompleteStillGrounding(observation, contributions)
    : allGroupsGrounded;
  return allFieldsObserved && stillGroundingReady && groundedVlmSucceeded && !hasGap
    ? "ready"
    : "partial";
}

function hasCompleteStillGrounding(
  observation: EditorialObservation,
  contributions: ObservationContribution[],
): boolean {
  const groundedVlm = contributions.find((item) => item.producer.producer === "grounded_vlm");
  const measurement = contributions.find((item) => item.producer.producer === "deterministic_measurement");
  const applicability = contributions.find((item) => item.producer.producer === "media_kind_router");
  if (
    groundedVlm?.status !== "ready" ||
    measurement?.status === "skipped" ||
    !measurement ||
    applicability?.status === "skipped" ||
    !applicability ||
    observation.warnings.length > 0
  ) return false;

  const verifiedFrames = groundedVlm.evidence.filter((item) =>
    item.evidence_type === "verified_frame" &&
    typeof item.artifact_ref === "string" && item.artifact_ref.length > 0
  );
  if (
    groundedVlm.producer.actual_verified_frame_count < 1 ||
    verifiedFrames.length !== groundedVlm.producer.actual_verified_frame_count ||
    !/^[a-f0-9]{64}$/.test(groundedVlm.producer.source_content_sha256 ?? "") ||
    !groundedVlm.producer.cache_identity
  ) return false;

  const measuredFields = new Set(measurement.evidence
    .filter((item) => item.evidence_type === "deterministic_measurement")
    .flatMap((item) => item.fields));
  if (measurement.producer.actual_verified_frame_count < 1 || !measuredFields.has("avg_luma")) return false;

  const applicableFields = new Set(applicability.evidence
    .filter((item) => item.evidence_type === "applicability")
    .flatMap((item) => item.fields));
  if (!["motion_type", "camera_motion_direction", "subject_motion_direction"]
    .every((field) => applicableFields.has(field as ObservationField))) return false;

  const evidencedFields = new Set(observation.evidence
    .filter((item) => item.evidence_type !== "producer_gap")
    .flatMap((item) => item.fields));
  return (Object.keys(FIELD_GROUP) as ObservationField[]).every((field) => evidencedFields.has(field));
}

function measuredMotionType(energy: number): MotionType {
  if (!Number.isFinite(energy)) return "unknown";
  if (energy < 0.03) return "static";
  if (energy < 0.12) return "subtle";
  if (energy < 0.45) return "continuous";
  return "rapid";
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

function uniqueEvidence(values: ObservationEvidence[]): ObservationEvidence[] {
  const byKey = new Map<string, ObservationEvidence>();
  for (const value of values) byKey.set(`${value.evidence_ref}:${value.fields.join(",")}`, value);
  return [...byKey.values()];
}

function uniqueProducers(values: ObservationProducerProvenance[]): ObservationProducerProvenance[] {
  const byKey = new Map<string, ObservationProducerProvenance>();
  for (const value of values) byKey.set(`${value.producer}:${value.cache_identity ?? value.prompt_hash ?? value.producer_version}`, value);
  return [...byKey.values()];
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function serializeValue(value: unknown): string {
  return JSON.stringify(value).replace(/\s+/g, "");
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
