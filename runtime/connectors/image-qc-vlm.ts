/**
 * Issue 37 still-image QC contract.
 *
 * The connector owns the small, deterministic contract shared by the public
 * analysis route and the report validator: prompt construction, response
 * normalization, defect taxonomy, scoring, and bounded repair constraints.
 * Provider I/O remains in the analysis gate so an unavailable optional model
 * can be classified by the Issue 44 policy without inventing a result.
 */

import * as path from "node:path";
import { createHash } from "node:crypto";

export const DEFAULT_IMAGE_QC_MODEL = "gemini-2.5-flash-lite";
export const DEFAULT_IMAGE_QC_REGENERATION_MODEL = "gemini-2.5-flash-image";
export const IMAGE_QC_CONNECTOR_VERSION = "image-qc-vlm-v1.0.0";
export const IMAGE_QC_PROMPT_TEMPLATE_ID = "image-qc-inspection-v1";
export const IMAGE_QC_RESPONSE_FORMAT = "image_qc_json_v1";

export type ImageQcDefectCode =
  | "extra_hands"
  | "extra_fingers"
  | "thumb_rotation"
  | "wrist_angle"
  | "limb_anomaly"
  | "unnecessary_frame_border"
  | "grotesque_dense_cluster"
  | "garbled_text"
  | "wardrobe_mismatch"
  | "prop_mismatch"
  | "setting_mismatch"
  | "other";

export type ImageQcDefectSeverity = "critical" | "major" | "minor";

export interface ImageQcDefect {
  code: ImageQcDefectCode;
  description: string;
  severity: ImageQcDefectSeverity;
  location: string | null;
}

export interface ImageQcCheckResult {
  evaluable: boolean;
  score: number | null;
  defects: ImageQcDefect[];
  hands_detected: number | null;
  expected_hands_max: number | null;
  fingers_detected_max: number | null;
  expected_fingers: number | null;
}

export interface ImageQcInspection {
  people_detected: boolean;
  people_count: number | null;
  hand_finger_count_check: ImageQcCheckResult;
  composition_artifact_check: ImageQcCheckResult;
  brief_semantic_consistency: ImageQcCheckResult;
  notes: string[];
}

export interface ImageQcPolicy {
  approve_at_or_above: number;
  max_regeneration_attempts: number;
  critical_defect_rejects: boolean;
}

export const DEFAULT_IMAGE_QC_POLICY: ImageQcPolicy = {
  approve_at_or_above: 0.85,
  max_regeneration_attempts: 2,
  critical_defect_rejects: true,
};

export interface ImageQcRepairConstraints {
  negative: string[];
  positive: string[];
}

export type ImageQcVerdict = "approved" | "rejected";

export interface ImageQcVerdictResult {
  overall_score: number;
  verdict: ImageQcVerdict;
  rejection_reasons: string[];
}

export interface ImageQcProviderIdentity {
  provider: string;
  model: string;
}

export type ImageQcExecutionMode = "production" | "test" | "untrusted";

export interface ImageQcInspectionRequest {
  project_id: string;
  asset_id: string;
  frame_path: string;
  frame_sha256: string;
  prompt: string;
  brief_context_sha256: string;
  attempt_index: number;
  repair_constraints: ImageQcRepairConstraints | null;
  report_identity: string;
}

/** Provider output after parsing. Raw request/response bytes never enter the report. */
export interface ImageQcExecutionResult {
  inspection: ImageQcInspection;
  provider: string;
  model: string;
  prompt_sha256: string;
}

export type ImageQcInspectionFn = (
  request: ImageQcInspectionRequest,
) => Promise<ImageQcExecutionResult>;

export interface ImageQcRegenerationRequest {
  asset_id: string;
  frame_path: string;
  frame_sha256: string;
  repair_constraints: ImageQcRepairConstraints;
  attempt: number;
}

export interface ImageQcRegenerationResult {
  provider: string;
  model: string;
}

export type ImageQcRegenerationFn = (
  request: ImageQcRegenerationRequest,
) => Promise<ImageQcRegenerationResult>;

// ── Prompt ────────────────────────────────────────────────────────────

export function buildImageQcPrompt(briefContext: string): string {
  const brief = briefContext.trim() || "No brief context is available.";
  return `You are a strict visual QC inspector for AI-generated still images used in video production.

Inspect the attached image and evaluate exactly these checks:

1. hand_finger_count_check: If people are depicted, count hands (at most 2 per person), count fingers (exactly 5 per hand), and detect wrong thumb/wrist rotation or malformed limbs. Report people_count, hands_detected, expected_hands_max, fingers_detected_max, and expected_fingers. Set evaluable=false only when no person is depicted.
2. composition_artifact_check: Detect unnecessary internal frame borders or empty panels, grotesque abnormally dense clusters, and garbled or warped text. This check is always evaluable.
3. brief_semantic_consistency: Compare wardrobe, props, and setting against the brief context below. Set evaluable=false only when the brief has no verifiable requirement.

Brief context:
"${brief}"

Score every evaluable check from 0.0 (severely defective) to 1.0 (clean).
Report defects with one of: extra_hands, extra_fingers, thumb_rotation, wrist_angle, limb_anomaly, unnecessary_frame_border, grotesque_dense_cluster, garbled_text, wardrobe_mismatch, prop_mismatch, setting_mismatch, other.
Use critical for unusable defects, major for clearly wrong defects, and minor for cosmetic defects.

Respond with JSON only using this shape:
{
  "people_detected": true,
  "people_count": 1,
  "hand_finger_count_check": {"evaluable": true, "score": 0.95, "hands_detected": 2, "expected_hands_max": 2, "fingers_detected_max": 5, "expected_fingers": 5, "defects": []},
  "composition_artifact_check": {"evaluable": true, "score": 0.95, "defects": []},
  "brief_semantic_consistency": {"evaluable": true, "score": 0.95, "defects": []},
  "notes": []
}`;
}

export function buildImageQcRepairPrompt(
  basePrompt: string,
  constraints: ImageQcRepairConstraints,
): string {
  const negative = constraints.negative.map((item) => `- ${item}`).join("\n");
  const positive = constraints.positive.map((item) => `- ${item}`).join("\n");
  return `${basePrompt}

REPAIR CONSTRAINTS from the previous inspection (apply strictly):
Do not accept images that violate any of:
${negative}

Require exactly:
${positive}`;
}

export function computeImageQcPromptHash(
  briefContext: string,
  constraints?: ImageQcRepairConstraints,
): string {
  const normalized = buildImageQcRepairPrompt(
    buildImageQcPrompt(briefContext),
    constraints ?? { negative: ["<none>"], positive: ["<none>"] },
  ).trim().replace(/\s+/g, " ");
  return `sha256:${createHash("sha256").update(normalized).digest("hex")}`;
}

// ── Parse + normalize ────────────────────────────────────────────────

interface RawImageQcResponse {
  people_detected?: unknown;
  people_count?: unknown;
  hand_finger_count_check?: unknown;
  composition_artifact_check?: unknown;
  brief_semantic_consistency?: unknown;
  notes?: unknown;
}

export function parseImageQcJson(raw: string): RawImageQcResponse {
  let cleaned = raw.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
  }
  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace <= firstBrace) {
    throw new Error("image_qc_malformed_response");
  }
  return JSON.parse(cleaned.slice(firstBrace, lastBrace + 1)) as RawImageQcResponse;
}

const VALID_DEFECT_CODES = new Set<ImageQcDefectCode>([
  "extra_hands", "extra_fingers", "thumb_rotation", "wrist_angle", "limb_anomaly",
  "unnecessary_frame_border", "grotesque_dense_cluster", "garbled_text",
  "wardrobe_mismatch", "prop_mismatch", "setting_mismatch", "other",
]);
const VALID_SEVERITIES = new Set<ImageQcDefectSeverity>(["critical", "major", "minor"]);

/** Remove provider-controlled secret/error-shaped fragments before persistence. */
export function sanitizeImageQcText(value: string, maxLength = 400): string {
  return value
    .replace(/https?:\/\/[^\s"']+/gi, "[url removed]")
    .replace(/\b(?:token|api[_ -]?key|secret|authorization|credential)\s*[:=]\s*(?:bearer\s+)?[^\s,;]+/gi, "[sensitive value removed]")
    .replace(/\bbearer\s+[^\s,;]+/gi, "[sensitive value removed]")
    .replace(/\brequest[_ -]?id\s*[:=]\s*[^\s,;]+/gi, "[request id removed]")
    .replace(/\b(?:query(?:_string)?(?:params)?|search[_ -]?params?)\s*[:=]\s*[^\s,;]+/gi, "[query removed]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength) || "unspecified defect";
}

export function normalizeImageQcResult(raw: RawImageQcResponse): ImageQcInspection {
  const hand = normalizeCheck(raw.hand_finger_count_check, true);
  const composition = normalizeCheck(raw.composition_artifact_check, false);
  if (raw.people_detected === true && !hand.evaluable) {
    throw new Error("image_qc_anatomy_unevaluable");
  }
  if (!composition.evaluable) {
    throw new Error("image_qc_composition_unevaluable");
  }
  return {
    people_detected: typeof raw.people_detected === "boolean" ? raw.people_detected : hand.evaluable,
    people_count: nullableCount(raw.people_count),
    hand_finger_count_check: hand,
    composition_artifact_check: composition,
    brief_semantic_consistency: normalizeCheck(raw.brief_semantic_consistency, false),
    notes: Array.isArray(raw.notes)
      ? raw.notes.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        .map((item) => sanitizeImageQcText(item, 300)).slice(0, 8)
      : [],
  };
}

function normalizeCheck(raw: unknown, anatomy: boolean): ImageQcCheckResult {
  const record = isRecord(raw) ? raw : {};
  const evaluable = record.evaluable === true;
  const score = evaluable ? clampScore(record.score) : null;
  if (evaluable && score === null) throw new Error("image_qc_evaluable_score_missing");
  const result: ImageQcCheckResult = {
    evaluable,
    score,
    defects: normalizeDefects(record.defects),
    hands_detected: null,
    expected_hands_max: null,
    fingers_detected_max: null,
    expected_fingers: null,
  };
  if (anatomy) {
    result.hands_detected = nullableCount(record.hands_detected);
    result.expected_hands_max = nullableCount(record.expected_hands_max);
    result.fingers_detected_max = nullableCount(record.fingers_detected_max);
    result.expected_fingers = nullableCount(record.expected_fingers);
  }
  return result;
}

function normalizeDefects(raw: unknown): ImageQcDefect[] {
  if (!Array.isArray(raw)) return [];
  const defects: ImageQcDefect[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const rawCode = typeof item.code === "string" ? item.code : "other";
    const rawSeverity = typeof item.severity === "string" ? item.severity : "major";
    defects.push({
      code: VALID_DEFECT_CODES.has(rawCode as ImageQcDefectCode) ? rawCode as ImageQcDefectCode : "other",
      description: sanitizeImageQcText(typeof item.description === "string" ? item.description : "unspecified defect"),
      severity: VALID_SEVERITIES.has(rawSeverity as ImageQcDefectSeverity) ? rawSeverity as ImageQcDefectSeverity : "major",
      location: typeof item.location === "string" && item.location.trim()
        ? sanitizeImageQcText(item.location, 200)
        : null,
    });
    if (defects.length >= 32) break;
  }
  return defects;
}

function clampScore(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(1, value));
}

function nullableCount(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return Math.floor(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ── Deterministic verdict + repair constraints ───────────────────────

export const IMAGE_QC_MAX_HANDS_PER_PERSON = 2;
export const IMAGE_QC_MAX_FINGERS_PER_HAND = 5;

export function deriveCountContradictionDefects(inspection: ImageQcInspection): ImageQcDefect[] {
  const hand = inspection.hand_finger_count_check;
  const people = inspection.people_count;
  const derived: ImageQcDefect[] = [];
  if (hand.hands_detected !== null) {
    if (people !== null && people > 0) {
      const allowance = IMAGE_QC_MAX_HANDS_PER_PERSON * people;
      if (hand.hands_detected > allowance) {
        derived.push({
          code: "extra_hands",
          description: `count contradiction: hands_detected ${hand.hands_detected} exceeds total hand allowance ${allowance}`,
          severity: "critical",
          location: null,
        });
      }
    } else if (hand.hands_detected > IMAGE_QC_MAX_HANDS_PER_PERSON) {
      derived.push({
        code: "other",
        description: `anatomy count ambiguity: hands_detected ${hand.hands_detected} exceeds canonical allowance`,
        severity: "critical",
        location: null,
      });
    }
  }
  if (hand.fingers_detected_max !== null && hand.fingers_detected_max > IMAGE_QC_MAX_FINGERS_PER_HAND) {
    derived.push({
      code: "extra_fingers",
      description: `count contradiction: ${hand.fingers_detected_max} fingers observed on one hand exceeds expected ${IMAGE_QC_MAX_FINGERS_PER_HAND}`,
      severity: "critical",
      location: null,
    });
  }
  return derived;
}

export function effectiveDefects(inspection: ImageQcInspection): ImageQcDefect[] {
  const all = [
    ...inspection.hand_finger_count_check.defects,
    ...inspection.composition_artifact_check.defects,
    ...inspection.brief_semantic_consistency.defects,
    ...deriveCountContradictionDefects(inspection),
  ];
  const seen = new Set<string>();
  return all.filter((defect) => {
    const key = `${defect.code}:${defect.description}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function computeImageQcOverallScore(inspection: ImageQcInspection): number {
  const scores = [
    inspection.hand_finger_count_check,
    inspection.composition_artifact_check,
    inspection.brief_semantic_consistency,
  ].filter((check) => check.evaluable && typeof check.score === "number")
    .map((check) => check.score as number);
  if (scores.length === 0) throw new Error("image_qc_no_evaluable_checks");
  return Math.round((scores.reduce((sum, score) => sum + score, 0) / scores.length) * 1000) / 1000;
}

export function computeImageQcVerdict(
  inspection: ImageQcInspection,
  policy: ImageQcPolicy,
  context: { briefAvailable?: boolean } = {},
): ImageQcVerdictResult {
  const overallScore = computeImageQcOverallScore(inspection);
  const rejectionReasons: string[] = [];
  if (inspection.people_detected && !inspection.hand_finger_count_check.evaluable) {
    rejectionReasons.push("anatomy_unevaluable_with_people_detected");
  }
  if (context.briefAvailable === false) {
    rejectionReasons.push("semantic_evaluation_unavailable_brief_unavailable");
  } else if (context.briefAvailable === true && !inspection.brief_semantic_consistency.evaluable) {
    rejectionReasons.push("semantic_evaluation_not_evaluable");
  }
  for (const defect of effectiveDefects(inspection)) {
    if (policy.critical_defect_rejects && defect.severity === "critical") {
      rejectionReasons.push(`critical_defect:${defect.code}:${sanitizeImageQcText(defect.description)}`);
    }
  }
  if (overallScore < policy.approve_at_or_above) {
    rejectionReasons.push(`overall_score_below_threshold:${overallScore}<${policy.approve_at_or_above}`);
  }
  return {
    overall_score: overallScore,
    verdict: rejectionReasons.length > 0 ? "rejected" : "approved",
    rejection_reasons: rejectionReasons,
  };
}

const NEGATIVE_CONSTRAINT_BY_CODE: Record<ImageQcDefectCode, string> = {
  extra_hands: "each depicted person has at most two hands; no extra hands, arms, or limbs",
  extra_fingers: "each depicted hand has exactly five fingers; no extra, fused, or missing fingers",
  thumb_rotation: "thumbs and wrists are anatomically rotated and angled correctly",
  wrist_angle: "wrists are anatomically angled correctly",
  limb_anomaly: "arms, legs, and joints follow correct human anatomy",
  unnecessary_frame_border: "no photo frames, rectangular borders, or empty framed panels inside the scene",
  grotesque_dense_cluster: "no insect-like, vein-like, or grotesque abnormally dense clusters",
  garbled_text: "no garbled, warped, or nonsensical text",
  wardrobe_mismatch: "wardrobe matches the brief exactly",
  prop_mismatch: "props match the brief exactly",
  setting_mismatch: "setting matches the brief exactly",
  other: "no visual anomalies",
};

const POSITIVE_CONSTRAINT_BY_CODE: Record<ImageQcDefectCode, string> = {
  extra_hands: "render exactly two hands per person with natural poses",
  extra_fingers: "render exactly five fingers per hand",
  thumb_rotation: "render natural thumb opposition and wrist angles",
  wrist_angle: "render natural, relaxed wrist angles",
  limb_anomaly: "render anatomically correct limbs and joints",
  unnecessary_frame_border: "render the scene edge-to-edge without inset frames or borders",
  grotesque_dense_cluster: "render a clean, sparse arrangement with clearly separated strands and objects",
  garbled_text: "render no text, or crisp legible text only if the brief requires it",
  wardrobe_mismatch: "render the exact wardrobe specified in the brief",
  prop_mismatch: "render the exact props specified in the brief",
  setting_mismatch: "render the exact setting specified in the brief",
  other: "render a clean, defect-free image",
};

export function buildRepairConstraints(defects: ImageQcDefect[]): ImageQcRepairConstraints {
  const negative: string[] = [];
  const positive: string[] = [];
  const seenCodes = new Set<ImageQcDefectCode>();
  for (const defect of defects) {
    if (!seenCodes.has(defect.code)) {
      seenCodes.add(defect.code);
      negative.push(NEGATIVE_CONSTRAINT_BY_CODE[defect.code]);
      positive.push(POSITIVE_CONSTRAINT_BY_CODE[defect.code]);
    }
    const detail = `avoid: ${sanitizeImageQcText(defect.description)}`;
    if (!negative.includes(detail)) negative.push(detail);
  }
  if (negative.length === 0) negative.push("no visual anomalies");
  if (positive.length === 0) positive.push("render a clean, defect-free image");
  return { negative, positive };
}

export function defectsOf(inspection: ImageQcInspection): ImageQcDefect[] {
  return effectiveDefects(inspection);
}

export function buildImageQcRegenerationPrompt(constraints: ImageQcRepairConstraints): string {
  return `Regenerate the attached image so it passes strict visual QC.

Keep the subject, pose, wardrobe, setting, and framing unless they are the defect.
Do not include any of:
${constraints.negative.map((item) => `- ${item}`).join("\n")}

Require exactly:
${constraints.positive.map((item) => `- ${item}`).join("\n")}

Return only the regenerated image, no text.`;
}

export function imageQcInspectionDigest(inspection: ImageQcInspection): string {
  return `sha256:${createHash("sha256").update(stableStringify(inspection)).digest("hex")}`;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
}

export function mimeTypeForPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  return "image/jpeg";
}
