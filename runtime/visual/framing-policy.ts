import * as fs from "node:fs";
import { createHash } from "node:crypto";
import { validateArtifact } from "../artifacts/loaders.js";
import type { VisualTransform, FramingMode } from "./types.js";

export interface FramingPolicyDocument {
  version: "framing-policy/v1";
  policy_id: string;
  checks: {
    person: { min_confidence: number };
    head: { min_confidence: number; eye_y_ratio: number };
    hand: {
      min_confidence: number;
      max_zoom: number;
      safe_rect: { left: number; top: number; right: number; bottom: number };
    };
    look_room: {
      yaw_threshold_radians: number;
      minimum_zoom_when_looking: number;
      positive_yaw_target_x: number;
      negative_yaw_target_x: number;
      neutral_target_x: number;
      minimum_margin: number;
    };
    headroom: {
      minimum_top_margin: number;
      target_eye_y: number;
    };
  };
  modes: Record<FramingMode, {
    max_zoom: number;
    target_head_height: number;
  }>;
  transform: {
    max_pan_fraction: number;
  };
  confidence: {
    coverage_weight: number;
    observation_weight: number;
    stability_weight: number;
    stability_reference_span: number;
    safe_degrade_multiplier: number;
  };
  degrade: {
    missing_evidence: "manual_fallback" | "identity";
    failed_check: "safe_degrade" | "manual_fallback";
    fallback_mode: FramingMode;
    identity_zoom: number;
    zoom_step: number;
  };
}

/** Stable content identity for the parsed policy that the evaluator consumes. */
export function framingPolicyContentHash(policy: FramingPolicyDocument): string {
  return `sha256:${createHash("sha256").update(canonicalJson(policy)).digest("hex")}`;
}

/** Existing deterministic canonical form used by visual evidence hashes. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }
  return value;
}

export interface FramingBox {
  x: number;
  y: number;
  width: number;
  height: number;
  confidence: number;
  yaw_radians?: number;
  eye_x?: number;
  eye_y?: number;
}

export interface FramingPoint {
  x: number;
  y: number;
  confidence: number;
}

/** Normalized top-left coordinates. A local adapter must normalize its source first. */
export interface FramingObservation {
  time_us?: number;
  time_seconds?: number;
  person?: FramingBox;
  head?: FramingBox;
  hands?: FramingPoint[];
}

export interface FramingOutput {
  width: number;
  height: number;
}

export interface FramingEvaluationInput {
  observations: FramingObservation[];
  output: FramingOutput;
  mode: FramingMode;
  manual_transform?: VisualTransform;
  /** Optional author-proposed transform; it is checked, never trusted directly. */
  requested_transform?: VisualTransform;
}

export type FramingCheckStatus = "pass" | "fail" | "not_evaluated";

export interface FramingCheckResult {
  status: FramingCheckStatus;
  evidence_count: number;
  reason: string;
}

export interface FramingPolicyResult {
  version: "framing-result/v1";
  policy_id: string;
  policy_version: "framing-policy/v1";
  status: "ready" | "degraded" | "manual_fallback";
  requested_mode: FramingMode;
  applied_mode: FramingMode | "manual";
  transform: VisualTransform;
  confidence: number;
  degraded: boolean;
  degrade_reason?: string;
  checks: {
    person: FramingCheckResult;
    head: FramingCheckResult;
    transform: FramingCheckResult;
    hand: FramingCheckResult;
    look_room: FramingCheckResult;
    headroom: FramingCheckResult;
  };
}

export class FramingPolicyError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Framing policy is invalid: ${issues.join("; ")}`);
    this.name = "FramingPolicyError";
  }
}

export function parseFramingPolicy(input: unknown): FramingPolicyDocument {
  const issues: string[] = [];
  const value = asRecord(input);
  if (!value) throw new FramingPolicyError(["document must be an object"]);
  if (value.version !== "framing-policy/v1") issues.push("version must be framing-policy/v1");
  if (typeof value.policy_id !== "string" || value.policy_id.trim() === "") issues.push("policy_id must be a non-empty string");

  const checks = asRecord(value.checks);
  const person = asRecord(checks?.person);
  const head = asRecord(checks?.head);
  const hand = asRecord(checks?.hand);
  const safeRect = asRecord(hand?.safe_rect);
  const lookRoom = asRecord(checks?.look_room);
  const headroom = asRecord(checks?.headroom);
  requireConfidence(person?.min_confidence, "checks.person.min_confidence", issues);
  requireConfidence(head?.min_confidence, "checks.head.min_confidence", issues);
  requireUnit(head?.eye_y_ratio, "checks.head.eye_y_ratio", issues);
  requireConfidence(hand?.min_confidence, "checks.hand.min_confidence", issues);
  requireAtLeastOne(hand?.max_zoom, "checks.hand.max_zoom", issues, 1);
  requireUnit(safeRect?.left, "checks.hand.safe_rect.left", issues);
  requireUnit(safeRect?.top, "checks.hand.safe_rect.top", issues);
  requireUnit(safeRect?.right, "checks.hand.safe_rect.right", issues);
  requireUnit(safeRect?.bottom, "checks.hand.safe_rect.bottom", issues);
  if (isFiniteNumber(safeRect?.left) && isFiniteNumber(safeRect?.right) && safeRect.left >= safeRect.right) {
    issues.push("checks.hand.safe_rect.left must be less than right");
  }
  if (isFiniteNumber(safeRect?.top) && isFiniteNumber(safeRect?.bottom) && safeRect.top >= safeRect.bottom) {
    issues.push("checks.hand.safe_rect.top must be less than bottom");
  }
  requireNonNegative(lookRoom?.yaw_threshold_radians, "checks.look_room.yaw_threshold_radians", issues);
  requireAtLeastOne(lookRoom?.minimum_zoom_when_looking, "checks.look_room.minimum_zoom_when_looking", issues, 1);
  requireUnit(lookRoom?.positive_yaw_target_x, "checks.look_room.positive_yaw_target_x", issues);
  requireUnit(lookRoom?.negative_yaw_target_x, "checks.look_room.negative_yaw_target_x", issues);
  requireUnit(lookRoom?.neutral_target_x, "checks.look_room.neutral_target_x", issues);
  requireUnit(lookRoom?.minimum_margin, "checks.look_room.minimum_margin", issues);
  requireUnit(headroom?.minimum_top_margin, "checks.headroom.minimum_top_margin", issues);
  requireUnit(headroom?.target_eye_y, "checks.headroom.target_eye_y", issues);

  const modes = asRecord(value.modes);
  const parsedModes = {} as FramingPolicyDocument["modes"];
  for (const mode of ["wide", "punch", "hold"] as const) {
    const modeValue = asRecord(modes?.[mode]);
    requireAtLeastOne(modeValue?.max_zoom, `modes.${mode}.max_zoom`, issues, 1);
    requireUnit(modeValue?.target_head_height, `modes.${mode}.target_head_height`, issues, true);
    if (isFiniteNumber(modeValue?.target_head_height) && modeValue.target_head_height <= 0) {
      issues.push(`modes.${mode}.target_head_height must be greater than zero`);
    }
    parsedModes[mode] = {
      max_zoom: numberOr(modeValue?.max_zoom, 1),
      target_head_height: numberOr(modeValue?.target_head_height, 0.2),
    };
  }

  const transform = asRecord(value.transform);
  requireUnit(transform?.max_pan_fraction, "transform.max_pan_fraction", issues);
  const confidence = asRecord(value.confidence);
  requireUnit(confidence?.coverage_weight, "confidence.coverage_weight", issues);
  requireUnit(confidence?.observation_weight, "confidence.observation_weight", issues);
  requireUnit(confidence?.stability_weight, "confidence.stability_weight", issues);
  requireNonNegative(confidence?.stability_reference_span, "confidence.stability_reference_span", issues);
  if (isFiniteNumber(confidence?.stability_reference_span) && confidence.stability_reference_span <= 0) {
    issues.push("confidence.stability_reference_span must be greater than zero");
  }
  requireUnit(confidence?.safe_degrade_multiplier, "confidence.safe_degrade_multiplier", issues);

  const degrade = asRecord(value.degrade);
  if (degrade?.missing_evidence !== "manual_fallback" && degrade?.missing_evidence !== "identity") {
    issues.push("degrade.missing_evidence must be manual_fallback or identity");
  }
  if (degrade?.failed_check !== "safe_degrade" && degrade?.failed_check !== "manual_fallback") {
    issues.push("degrade.failed_check must be safe_degrade or manual_fallback");
  }
  if (!isFramingMode(degrade?.fallback_mode)) issues.push("degrade.fallback_mode must be wide, punch, or hold");
  requireAtLeastOne(degrade?.identity_zoom, "degrade.identity_zoom", issues, 0.000001);
  requireAtLeastOne(degrade?.zoom_step, "degrade.zoom_step", issues, Number.EPSILON);

  if (issues.length > 0) throw new FramingPolicyError(issues);
  return structuredClone({
    version: "framing-policy/v1",
    policy_id: String(value.policy_id).trim(),
    checks: {
      person: { min_confidence: Number(person!.min_confidence) },
      head: { min_confidence: Number(head!.min_confidence), eye_y_ratio: Number(head!.eye_y_ratio) },
      hand: {
        min_confidence: Number(hand!.min_confidence),
        max_zoom: Number(hand!.max_zoom),
        safe_rect: {
          left: Number(safeRect!.left),
          top: Number(safeRect!.top),
          right: Number(safeRect!.right),
          bottom: Number(safeRect!.bottom),
        },
      },
      look_room: {
        yaw_threshold_radians: Number(lookRoom!.yaw_threshold_radians),
        minimum_zoom_when_looking: Number(lookRoom!.minimum_zoom_when_looking),
        positive_yaw_target_x: Number(lookRoom!.positive_yaw_target_x),
        negative_yaw_target_x: Number(lookRoom!.negative_yaw_target_x),
        neutral_target_x: Number(lookRoom!.neutral_target_x),
        minimum_margin: Number(lookRoom!.minimum_margin),
      },
      headroom: {
        minimum_top_margin: Number(headroom!.minimum_top_margin),
        target_eye_y: Number(headroom!.target_eye_y),
      },
    },
    modes: parsedModes,
    transform: { max_pan_fraction: Number(transform!.max_pan_fraction) },
    confidence: {
      coverage_weight: Number(confidence!.coverage_weight),
      observation_weight: Number(confidence!.observation_weight),
      stability_weight: Number(confidence!.stability_weight),
      stability_reference_span: Number(confidence!.stability_reference_span),
      safe_degrade_multiplier: Number(confidence!.safe_degrade_multiplier),
    },
    degrade: {
      missing_evidence: degrade!.missing_evidence as "manual_fallback" | "identity",
      failed_check: degrade!.failed_check as "safe_degrade" | "manual_fallback",
      fallback_mode: degrade!.fallback_mode as FramingMode,
      identity_zoom: Number(degrade!.identity_zoom),
      zoom_step: Number(degrade!.zoom_step),
    },
  });
}

export function loadFramingPolicy(filePath: string): FramingPolicyDocument {
  const raw = JSON.parse(fs.readFileSync(filePath, "utf-8")) as unknown;
  return parseFramingPolicy(validateArtifact<FramingPolicyDocument>(raw, "framing-policy.schema.json"));
}

export function evaluateFramingPolicy(
  input: FramingEvaluationInput,
  policy: FramingPolicyDocument,
): FramingPolicyResult {
  const requestedMode = input.mode;
  const outputValid = Number.isInteger(input.output.width) && input.output.width > 0 &&
    Number.isInteger(input.output.height) && input.output.height > 0;
  const observations = normalizeObservations(input.observations);
  const identity = identityTransform(policy);
  const emptyChecks = missingChecks("no usable framing observations");
  if (!outputValid || observations.length === 0) {
    return manualFallback(input, policy, outputValid ? "missing_framing_evidence" : "invalid_output_dimensions", emptyChecks);
  }

  const first = evaluateMode(input, policy, observations, requestedMode);
  if (first.baseEvidenceMissing) {
    return manualFallback(input, policy, "person_or_head_evidence_missing", first.checks);
  }
  if (allChecksPass(first.checks)) {
    return {
      version: "framing-result/v1",
      policy_id: policy.policy_id,
      policy_version: policy.version,
      status: "ready",
      requested_mode: requestedMode,
      applied_mode: requestedMode,
      transform: first.transform,
      confidence: first.confidence,
      degraded: false,
      checks: first.checks,
    };
  }

  if (policy.degrade.failed_check === "safe_degrade" && policy.degrade.fallback_mode !== requestedMode) {
    const fallback = evaluateMode({ ...input, requested_transform: undefined }, policy, observations, policy.degrade.fallback_mode);
    if (!fallback.baseEvidenceMissing && allChecksPass(fallback.checks)) {
      return {
        version: "framing-result/v1",
        policy_id: policy.policy_id,
        policy_version: policy.version,
        status: "degraded",
        requested_mode: requestedMode,
        applied_mode: policy.degrade.fallback_mode,
        transform: fallback.transform,
        confidence: round(fallback.confidence * policy.confidence.safe_degrade_multiplier, 3),
        degraded: true,
        degrade_reason: `safe_degrade:${failedCheckNames(first.checks).join(",")}`,
        checks: fallback.checks,
      };
    }
  }

  return manualFallback(
    input,
    policy,
    `manual_fallback:${failedCheckNames(first.checks).join(",") || "policy_check_failed"}`,
    first.checks,
    identity,
  );
}

interface ModeEvaluation {
  transform: VisualTransform;
  confidence: number;
  checks: FramingPolicyResult["checks"];
  baseEvidenceMissing: boolean;
}

function evaluateMode(
  input: FramingEvaluationInput,
  policy: FramingPolicyDocument,
  observations: FramingObservation[],
  mode: FramingMode,
): ModeEvaluation {
  const personObservations = observations.filter((observation) => usableBox(observation.person, policy.checks.person.min_confidence));
  const headObservations = observations.filter((observation) => usableBox(observation.head, policy.checks.head.min_confidence));
  const personCheck = check(
    personObservations.length > 0 ? "pass" : "fail",
    personObservations.length,
    personObservations.length > 0 ? "person evidence meets policy" : "no person evidence meets policy",
  );
  const headCheck = check(
    headObservations.length > 0 ? "pass" : "fail",
    headObservations.length,
    headObservations.length > 0 ? "head evidence meets policy" : "no head evidence meets policy",
  );
  const heads = headObservations.map((observation) => observation.head!);
  const handPoints = observations.flatMap((observation) => observation.hands ?? [])
    .filter((hand) => isFiniteNumber(hand.x) && isFiniteNumber(hand.y) && hand.confidence >= policy.checks.hand.min_confidence);
  const modePolicy = policy.modes[mode];
  const faceHeight = median(heads.map((head) => head.height));
  const faceCenterX = median(heads.map((head) => head.eye_x ?? head.x + head.width / 2));
  const eyeY = median(heads.map((head) => head.eye_y ?? head.y + head.height * policy.checks.head.eye_y_ratio));
  const yawValues = heads.flatMap((head) => isFiniteNumber(head.yaw_radians) ? [head.yaw_radians] : []);
  const yaw = yawValues.length > 0 ? median(yawValues) : 0;
  const maxZoom = handPoints.length > 0 ? Math.min(modePolicy.max_zoom, policy.checks.hand.max_zoom) : modePolicy.max_zoom;
  const baseZoom = clamp(
    modePolicy.target_head_height / Math.max(Number.EPSILON, faceHeight),
    1,
    maxZoom,
  );
  const targetFaceX = yaw > policy.checks.look_room.yaw_threshold_radians
    ? policy.checks.look_room.positive_yaw_target_x
    : yaw < -policy.checks.look_room.yaw_threshold_radians
      ? policy.checks.look_room.negative_yaw_target_x
      : policy.checks.look_room.neutral_target_x;
  const zoom = Math.abs(yaw) > policy.checks.look_room.yaw_threshold_radians
    ? Math.max(baseZoom, policy.checks.look_room.minimum_zoom_when_looking)
    : baseZoom;
  const calculatedTransform = buildTransform(zoom, faceCenterX, eyeY, targetFaceX, input.output, policy);
  const hasRequestedTransform = input.requested_transform !== undefined;
  const requestedTransformIsValid = validTransform(input.requested_transform);
  const transform = requestedTransformIsValid ? input.requested_transform! : calculatedTransform;
  const transformCheck = !hasRequestedTransform
    ? check("pass", 0, "transform calculated by the framing policy")
    : !requestedTransformIsValid
      ? check("fail", 0, "requested transform is invalid")
      : checkTransform(transform, modePolicy, policy, handPoints.length > 0);
  const handCheck = handPoints.length === 0
    ? check("not_evaluated", 0, "no confident hand evidence")
    : check(
      handPoints.every((hand) => inSafeRect(transformPoint(hand.x, hand.y, transform, input.output), policy.checks.hand.safe_rect))
        ? "pass"
        : "fail",
      handPoints.length,
      handPoints.every((hand) => inSafeRect(transformPoint(hand.x, hand.y, transform, input.output), policy.checks.hand.safe_rect))
        ? "confident hands remain in the policy safe rect"
        : "a confident hand leaves the policy safe rect",
    );
  const lookHeads = heads.filter((head) => isFiniteNumber(head.yaw_radians) && Math.abs(head.yaw_radians!) >= policy.checks.look_room.yaw_threshold_radians);
  const lookRoomCheck = lookHeads.length === 0
    ? check("not_evaluated", 0, "no confident look direction evidence")
    : check(
      lookHeads.every((head) => Math.abs(transformPoint(head.eye_x ?? head.x + head.width / 2, head.y, transform, input.output).x - targetFaceX) <= policy.checks.look_room.minimum_margin + 1e-9)
        ? "pass"
        : "fail",
      lookHeads.length,
      lookHeads.every((head) => Math.abs(transformPoint(head.eye_x ?? head.x + head.width / 2, head.y, transform, input.output).x - targetFaceX) <= policy.checks.look_room.minimum_margin + 1e-9)
        ? "look-room target is preserved"
        : "look-room target is outside the policy margin",
    );
  const headroomCheck = heads.length === 0
    ? check("fail", 0, "headroom cannot be evaluated without head evidence")
    : check(
      heads.every((head) => {
        const top = transformPoint(head.x, head.y, transform, input.output).y;
        return top >= policy.checks.headroom.minimum_top_margin;
      })
        ? "pass"
        : "fail",
      heads.length,
      heads.every((head) => transformPoint(head.x, head.y, transform, input.output).y >= policy.checks.headroom.minimum_top_margin)
        ? "headroom remains above the policy margin"
        : "a head would cross the policy headroom margin",
    );
  const coverage = personObservations.length / Math.max(1, observations.length);
  const averageConfidence = heads.length > 0
    ? heads.map((head) => head.confidence).reduce((sum, value) => sum + value, 0) / heads.length
    : 0;
  const centerSpread = percentileSpread(heads.map((head) => head.x + head.width / 2));
  const stability = clamp(1 - centerSpread / policy.confidence.stability_reference_span, 0, 1);
  const confidence = round(clamp(
    coverage * policy.confidence.coverage_weight +
      averageConfidence * policy.confidence.observation_weight +
      stability * policy.confidence.stability_weight,
    0,
    1,
  ), 3);
  return {
    transform,
    confidence,
    checks: { person: personCheck, head: headCheck, transform: transformCheck, hand: handCheck, look_room: lookRoomCheck, headroom: headroomCheck },
    baseEvidenceMissing: personObservations.length === 0 || headObservations.length === 0,
  };
}

function manualFallback(
  input: FramingEvaluationInput,
  policy: FramingPolicyDocument,
  reason: string,
  checks: FramingPolicyResult["checks"],
  fallbackTransform?: VisualTransform,
): FramingPolicyResult {
  const manual = validTransform(input.manual_transform) ? input.manual_transform! : fallbackTransform ?? identityTransform(policy);
  return {
    version: "framing-result/v1",
    policy_id: policy.policy_id,
    policy_version: policy.version,
    status: "manual_fallback",
    requested_mode: input.mode,
    applied_mode: "manual",
    transform: manual,
    confidence: 0,
    degraded: true,
    degrade_reason: reason,
    checks,
  };
}

function normalizeObservations(observations: FramingObservation[]): FramingObservation[] {
  if (!Array.isArray(observations)) return [];
  return observations
    .filter((observation): observation is FramingObservation => Boolean(observation) && typeof observation === "object")
    .map((observation) => ({
      ...observation,
      hands: Array.isArray(observation.hands) ? [...observation.hands] : [],
    }))
    .sort((left, right) => observationTime(left) - observationTime(right));
}

function observationTime(observation: FramingObservation): number {
  if (isFiniteNumber(observation.time_us)) return observation.time_us!;
  if (isFiniteNumber(observation.time_seconds)) return observation.time_seconds! * 1_000_000;
  return 0;
}

function buildTransform(
  zoom: number,
  faceCenterX: number,
  eyeY: number,
  targetFaceX: number,
  output: FramingOutput,
  policy: FramingPolicyDocument,
): VisualTransform {
  const zoomedFaceX = (faceCenterX - 0.5) * zoom + 0.5;
  const zoomedEyeY = (eyeY - 0.5) * zoom + 0.5;
  const rawX = (targetFaceX - zoomedFaceX) * output.width;
  const rawY = (zoomedEyeY - policy.checks.headroom.target_eye_y) * output.height;
  const maxX = output.width * (zoom - 1) / 2 * policy.transform.max_pan_fraction;
  const maxY = output.height * (zoom - 1) / 2 * policy.transform.max_pan_fraction;
  return {
    zoom: round(zoom, 3),
    position: {
      x: round(clamp(rawX, -maxX, maxX), 1),
      y: round(clamp(rawY, -maxY, maxY), 1),
    },
  };
}

function transformPoint(
  x: number,
  y: number,
  transform: VisualTransform,
  output: FramingOutput,
): { x: number; y: number } {
  const zoom = transform.zoom ?? 1;
  const position = transform.position ?? { x: 0, y: 0 };
  return {
    x: (x - 0.5) * zoom + 0.5 + position.x / output.width,
    y: (y - 0.5) * zoom + 0.5 - position.y / output.height,
  };
}

function checkTransform(
  transform: VisualTransform,
  modePolicy: FramingPolicyDocument["modes"][FramingMode],
  policy: FramingPolicyDocument,
  hasConfidentHands: boolean,
): FramingCheckResult {
  const zoom = transform.zoom ?? 1;
  const maximumZoom = hasConfidentHands
    ? Math.min(modePolicy.max_zoom, policy.checks.hand.max_zoom)
    : modePolicy.max_zoom;
  return zoom >= 1 && zoom <= maximumZoom
    ? check("pass", 0, "requested transform stays within the policy zoom bound")
    : check("fail", 0, `requested zoom ${zoom} exceeds the policy bound ${maximumZoom}`);
}

function allChecksPass(checks: FramingPolicyResult["checks"]): boolean {
  return Object.values(checks).every((checkResult) => checkResult.status !== "fail");
}

function failedCheckNames(checks: FramingPolicyResult["checks"]): string[] {
  return Object.entries(checks)
    .filter(([, result]) => result.status === "fail")
    .map(([name]) => name);
}

function missingChecks(reason: string): FramingPolicyResult["checks"] {
  return {
    person: check("fail", 0, reason),
    head: check("fail", 0, reason),
    transform: check("not_evaluated", 0, reason),
    hand: check("not_evaluated", 0, reason),
    look_room: check("not_evaluated", 0, reason),
    headroom: check("not_evaluated", 0, reason),
  };
}

function check(status: FramingCheckStatus, evidence_count: number, reason: string): FramingCheckResult {
  return { status, evidence_count, reason };
}

function usableBox(box: FramingBox | undefined, minConfidence: number): box is FramingBox {
  return Boolean(box) && box!.confidence >= minConfidence &&
    isFiniteNumber(box!.x) && isFiniteNumber(box!.y) &&
    isFiniteNumber(box!.width) && isFiniteNumber(box!.height) &&
    box!.width > 0 && box!.height > 0 && box!.x >= 0 && box!.y >= 0 &&
    box!.x + box!.width <= 1 && box!.y + box!.height <= 1;
}

function inSafeRect(point: { x: number; y: number }, rect: FramingPolicyDocument["checks"]["hand"]["safe_rect"]): boolean {
  return point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom;
}

function validTransform(transform: VisualTransform | undefined): transform is VisualTransform {
  if (!transform || typeof transform !== "object") return false;
  if (transform.zoom !== undefined && (!isFiniteNumber(transform.zoom) || transform.zoom <= 0)) return false;
  if (transform.position && (!isFiniteNumber(transform.position.x) || !isFiniteNumber(transform.position.y))) return false;
  if (transform.crop && (
    !isFiniteNumber(transform.crop.x) || !isFiniteNumber(transform.crop.y) ||
    !isFiniteNumber(transform.crop.width) || !isFiniteNumber(transform.crop.height) ||
    transform.crop.width <= 0 || transform.crop.height <= 0
  )) return false;
  return transform.zoom !== undefined || transform.position !== undefined || transform.crop !== undefined;
}

function identityTransform(policy: FramingPolicyDocument): VisualTransform {
  return { zoom: policy.degrade.identity_zoom, position: { x: 0, y: 0 } };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function percentileSpread(values: number[]): number {
  if (values.length === 0) return 1;
  return Math.max(...values) - Math.min(...values);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round(value: number, places: number): number {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
}

function asRecord(value: unknown): Record<string, any> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, any>
    : undefined;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isFramingMode(value: unknown): value is FramingMode {
  return value === "wide" || value === "punch" || value === "hold";
}

function numberOr(value: unknown, fallback: number): number {
  return isFiniteNumber(value) ? value : fallback;
}

function requireConfidence(value: unknown, path: string, issues: string[]): void {
  requireUnit(value, path, issues);
}

function requireUnit(value: unknown, path: string, issues: string[], allowZero = true): void {
  if (!isFiniteNumber(value) || value < (allowZero ? 0 : Number.EPSILON) || value > 1) {
    issues.push(`${path} must be a finite number between ${allowZero ? "0" : "greater than zero"} and 1`);
  }
}

function requireNonNegative(value: unknown, path: string, issues: string[]): void {
  if (!isFiniteNumber(value) || value < 0) issues.push(`${path} must be a finite non-negative number`);
}

function requireAtLeastOne(value: unknown, path: string, issues: string[], minimum: number): void {
  if (!isFiniteNumber(value) || value < minimum) issues.push(`${path} must be a finite number >= ${minimum}`);
}
