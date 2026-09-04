/**
 * Gemini VLM Connector — provider-agnostic visual language model enrichment.
 *
 * Per milestone-2-design.md §Gemini Video Understanding Connector:
 * - enrich segments.json with visual semantics (tags, summary, interest_points, quality_flags)
 * - adaptive sampling per segment_type
 * - output normalization (lower_snake_case tags, bounded interest_points)
 * - prompt hash capture for provenance
 * - token budget control
 * - parse retry + gap fallback
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { computeRequestHash } from "./ffprobe.js";
import type {
  ObservationGroupConfidence,
  ObservationValues,
} from "../pipeline/stages/editorial-observation.js";
import {
  buildVlmSchemaContractPrompt,
  formatVlmValidationError,
  getVlmProviderResponseSchema,
  getVlmRequiredPaths,
  validateVlmGroundingResponse,
  VLM_GROUNDING_RESPONSE_SCHEMA_VERSION,
  type VlmValidationError,
} from "../validation/vlm-grounding-response-validator.js";

// ── Constants ──────────────────────────────────────────────────────

export const VLM_CONNECTOR_VERSION = "gemini-vlm-v3.3.0";

/** Canonical prompt template for M2 segment enrichment. */
export const PROMPT_TEMPLATE_ID = "m2-segment-grounded-v3";

const PROMPT_TEMPLATE = `Analyze the following video segment frames. Return a JSON object with:
- "summary": a specific sentence about the visible action. Name the subject's posture/motion, objects held, and background features. Be concrete, not generic.
- "tags": array of descriptive tags (lowercase_snake_case, e.g. "outdoor_scene", "close_up", "campfire", "child_running", "tent_setup")
- "interest_points": array of notable moments, each with "frame_us" (microsecond timestamp), "label" (short description), "confidence" (0-1)
- "quality_flags": array of quality issues detected (from vocabulary: "underexposed", "overexposed", "blurry", "shaky", "noisy", "interlaced", "letterboxed", "pillarboxed")
- "confidence": object with "summary" (0-1), "tags" (0-1), "quality_flags" (0-1)
- "editorial_observation": genre-neutral visible facts. Use the schema-derived contract below for exact paths, required keys, enum values, and confidence bounds. Use "unknown" or "not_applicable" rather than guessing.
- "visual_quality": object with:
  - "scores": object with 0-1 numbers for "light_quality", "subject_prominence", "emotional_expression", "composition_score", "motion_quality"
  - "labels": object with string arrays for "lighting_style", "composition_tags", "expression_tags", "motion_tags"

visual_quality score rubric anchors:
- light_quality: 0.9=golden hour/expressive lighting, 0.5=flat even light, 0.1=severely under/overexposed
- subject_prominence: 0.9=subject sharp and dominant, 0.5=visible but not prominent, 0.1=absent/lost in background
- emotional_expression: 0.9=clear strong emotion visible, 0.5=neutral or no face/not applicable, 0.1=a visible intended expression is unreadable
- composition_score: 0.9=strong balance/geometry/framing, 0.5=functional framing, 0.1=chaotic/unintentional
- motion_quality: 0.9=intentional effective motion/stillness, 0.5=ordinary or not applicable, 0.1=unwanted/incoherent motion. It is an intent-relative appraisal, not a motion amount; a static landscape or title card is not low quality merely for being still.

${buildVlmSchemaContractPrompt()}

Respond ONLY with valid JSON, no markdown fences or explanation.`;

const REPAIR_PROMPT_PREFIX = "Return ONLY a JSON object satisfying the canonical response contract. Repair these paths:";

/** Compute SHA-256 hash of the normalized prompt template + schema version. */
export function computePromptHash(
  schemaVersion: string = VLM_GROUNDING_RESPONSE_SCHEMA_VERSION,
): string {
  const normalized = PROMPT_TEMPLATE.trim().replace(/\s+/g, " ");
  return createHash("sha256")
    .update(normalized + "|" + schemaVersion)
    .digest("hex")
    .slice(0, 16);
}

/** Compute SHA-256 hash of the repair prompt template. */
export function computeRepairPromptHash(): string {
  const normalized = REPAIR_PROMPT_PREFIX.trim().replace(/\s+/g, " ");
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

// ── Types ──────────────────────────────────────────────────────────

/** Segment types recognized by the adaptive sampling policy. */
export type SegmentType = "static" | "action" | "dialogue" | "music_driven" | "general";

/** Sampling policy from analysis-defaults.yaml. */
export interface SamplingPolicy {
  static: { sample_fps: number };
  action: { sample_fps_default: number; sample_fps_min: number; sample_fps_max: number };
  dialogue: { sample_fps: number };
  music_driven: { sample_fps: number };
  general: { sample_fps: number };
}

/** VLM policy from analysis-defaults.yaml. */
export interface VlmPolicy {
  model_alias: string;
  model_snapshot: string;
  input_mode: string;
  response_format: string;
  prompt_template_id: string;
  max_frame_width_px: number;
  segment_visual_token_budget_max: number;
  segment_visual_output_tokens_max: number;
  segment_visual_frame_cap: number;
  parse_retry_max: number;
}

/** Safe provider finish reasons retained in diagnostics and provenance. */
export type VlmFinishReason =
  | "STOP"
  | "MAX_TOKENS"
  | "SAFETY"
  | "RECITATION"
  | "LANGUAGE"
  | "OTHER"
  | "BLOCKLIST"
  | "PROHIBITED_CONTENT"
  | "SPII"
  | "MALFORMED_FUNCTION_CALL"
  | "EOF"
  | "unrecognized";

/** Why a provider response was classified as truncated. */
export type VlmTruncationReason = "max_tokens" | "eof";

/** Bounded reason that caused the one optional schema/parse repair. */
export type VlmRetryReason =
  | "truncated_json"
  | "no_candidate"
  | "no_text"
  | "no_json_span"
  | "json_syntax_error"
  | "schema_invalid"
  | "schema_empty"
  | "call_failure";

/** Conservative lower bound for a useful structured response. */
export const VLM_OUTPUT_TOKEN_BUDGET_MIN = 256;
/** Hard ceiling independent of malformed or over-large policy input. */
export const VLM_OUTPUT_TOKEN_BUDGET_HARD_MAX = 8_192;
const VLM_OUTPUT_TOKEN_BUDGET_DEFAULT_MAX = 1_024;
const VLM_OUTPUT_TOKEN_ROUNDING = 64;
const VLM_OUTPUT_TOKENS_PER_FRAME = 16;
const VLM_SCHEMA_BYTES_PER_TOKEN = 4;

/** Raw response expected from the VLM provider. */
export interface VlmRawResponse {
  summary?: string;
  tags?: unknown[];
  interest_points?: Array<{
    frame_us?: unknown;
    label?: unknown;
    confidence?: unknown;
  }>;
  quality_flags?: unknown[];
  confidence?: {
    summary?: unknown;
    tags?: unknown;
    quality_flags?: unknown;
  };
  visual_quality?: unknown;
  editorial_observation?: unknown;
}

export interface VlmVisualQuality {
  scores: {
    light_quality: number;
    subject_prominence: number;
    emotional_expression: number;
    composition_score: number;
    motion_quality: number;
  };
  labels: {
    lighting_style: string[];
    composition_tags: string[];
    expression_tags: string[];
    motion_tags: string[];
  };
}

/** Normalized VLM output after cleaning. */
export interface VlmNormalizedOutput {
  summary: string;
  tags: string[];
  interest_points: Array<{
    frame_us: number;
    label: string;
    confidence: number;
  }>;
  quality_flags: string[];
  confidence: {
    summary: number;
    tags: number;
    quality_flags: number;
  };
  visual_quality?: VlmVisualQuality;
  editorial_observation?: {
    values: ObservationValues;
    confidence: Partial<Record<keyof ObservationConfidenceMap, number>>;
  };
}

type ObservationConfidenceMap = Record<
  "tags" | "motion" | "framing" | "direction" | "appearance" | "text",
  ObservationGroupConfidence
>;

/** Result of a VLM enrichment call for one segment. */
export interface VlmEnrichmentResult {
  success: boolean;
  output?: VlmNormalizedOutput;
  error?: string;
  parse_diagnostics?: VlmParseDiagnostic[];
  prompt_hash: string;
  model_alias: string;
  model_snapshot: string;
  /** Locally requested, bounded generation budget for each provider attempt. */
  requested_output_tokens?: number;
  /** Final provider finish reason; null means the provider did not return one. */
  finish_reason?: VlmFinishReason | null;
  /** Number of provider requests represented by this call path. */
  attempt_count?: number;
  /** Reason for the repair attempt, or null when no repair was made. */
  retry_reason?: VlmRetryReason | null;
  frame_grounding?: VlmFrameGrounding;
}

export interface VlmFrameGrounding {
  frame_count: number;
  verified_frame_paths?: string[];
  sample_timestamps_us: number[];
  requested_sample_timestamps_us: number[];
  frame_cache_version: string;
  frame_producer_version: string;
  frame_cache_hits: number;
  frame_content_sha256?: string[];
  asset_source_content_sha256?: string;
  source_content_sha256?: string;
  segment_src_in_us?: number;
  segment_src_out_us?: number;
  cache_identity?: string;
  cache_decision?: "accepted" | "refreshed" | "miss";
  cache_decision_reasons?: string[];
  frame_extraction_failures?: string[];
}

/**
 * Provider-agnostic VLM function signature.
 * Accepts frames (as file paths) + context, returns raw JSON string.
 *
 * Implementations:
 * - Gemini: POST with frame bundle + text context
 * - Future: other VLM providers implementing the same interface
 */
export type VlmFn = (
  framePaths: string[],
  prompt: string,
  options: VlmCallOptions,
) => Promise<VlmCallResult>;

export interface VlmCallOptions {
  model: string;
  maxOutputTokens: number;
  /** Transcript context to include in the prompt (optional). */
  transcriptContext?: string;
  /** Canonical provider response schema used by structured-output routes. */
  responseSchema?: Record<string, unknown>;
}

export interface VlmCallResult {
  rawJson: string;
  provider_request_id?: string;
  response_diagnostic?: VlmResponseDiagnostic;
}

export type VlmParseStage =
  | "no_candidate"
  | "no_text"
  | "no_json_span"
  | "truncated_json"
  | "json_syntax_error"
  | "schema_invalid"
  | "schema_empty";

export type VlmResponsePartKind =
  | "text"
  | "thought_text"
  | "inline_data"
  | "file_data"
  | "function_call"
  | "function_response"
  | "executable_code"
  | "code_execution_result"
  | "empty"
  | "unknown"
  | "unavailable";

/** Privacy-safe response metadata. It never contains provider text or paths. */
export interface VlmResponseDiagnostic {
  candidate_count: number | null;
  finish_reason: VlmFinishReason | null;
  block_reason: string | null;
  blocked: boolean;
  candidates_token_count: number | null;
  thoughts_token_count: number | null;
  output_token_cap: number;
  text_bytes: number | null;
  text_sha256_16: string;
  part_count: number | null;
  text_part_count: number | null;
  first_part_kind: VlmResponsePartKind;
  has_open_brace: boolean;
  ends_with_close_brace: boolean;
  truncation_reason?: VlmTruncationReason | null;
}

export interface VlmParseDiagnostic {
  attempt_index: number;
  attempt_outcome: "parse_failure" | "call_failure";
  error_code: string;
  parse_stage?: VlmParseStage;
  response_scope?: "provider_envelope" | "candidate_text";
  json_error_offset?: number;
  present_top_level_keys?: string[];
  validation_errors?: VlmValidationError[];
  response?: VlmResponseDiagnostic;
}

// ── Quality Flag Vocabulary ────────────────────────────────────────

/** Repository-controlled vocabulary for quality flags. Raw provider adjectives are mapped to these. */
const QUALITY_FLAG_VOCABULARY = new Set([
  "underexposed",
  "overexposed",
  "blurry",
  "shaky",
  "noisy",
  "interlaced",
  "letterboxed",
  "pillarboxed",
]);

/** Map common raw provider adjectives to canonical vocabulary. */
const QUALITY_FLAG_ALIASES: Record<string, string> = {
  dark: "underexposed",
  dim: "underexposed",
  bright: "overexposed",
  washed_out: "overexposed",
  out_of_focus: "blurry",
  unfocused: "blurry",
  motion_blur: "blurry",
  shaking: "shaky",
  unstable: "shaky",
  handheld: "shaky",
  grainy: "noisy",
  grain: "noisy",
  noise: "noisy",
  interlacing: "interlaced",
  black_bars_horizontal: "letterboxed",
  black_bars_vertical: "pillarboxed",
};

// ── Adaptive Sampling ──────────────────────────────────────────────

/**
 * Compute the target FPS for frame sampling based on segment type and policy.
 */
export function getAdaptiveSampleFps(
  segmentType: SegmentType,
  policy: SamplingPolicy,
): number {
  switch (segmentType) {
    case "static":
      return policy.static.sample_fps;
    case "action":
      return policy.action.sample_fps_default;
    case "dialogue":
      return policy.dialogue.sample_fps;
    case "music_driven":
      return policy.music_driven.sample_fps;
    case "general":
      return policy.general.sample_fps;
    default:
      return policy.general.sample_fps;
  }
}

/**
 * Compute the number of frames to sample from a segment, respecting the frame cap.
 */
export function computeFrameCount(
  durationUs: number,
  fps: number,
  frameCap: number,
): number {
  const durationSec = durationUs / 1_000_000;
  const raw = Math.max(1, Math.ceil(durationSec * fps));
  return Math.min(raw, frameCap);
}

/**
 * Estimate the response shape cost from the canonical schema itself.
 *
 * This is deliberately a small owner-operated heuristic: it uses the
 * serialized schema size as a stable proxy for the amount of structured
 * output the contract can carry, then the caller adds a bounded per-frame
 * allowance for frame-specific interest points. Provider response content is
 * never inspected or retained by this calculation.
 */
export function estimateVlmSchemaOutputTokens(
  schema: Record<string, unknown> = getVlmProviderResponseSchema(),
): number {
  let serializedBytes = 0;
  try {
    const serialized = JSON.stringify(schema);
    serializedBytes = typeof serialized === "string" ? Buffer.byteLength(serialized) : 0;
  } catch {
    serializedBytes = 0;
  }
  const estimate = Math.ceil(serializedBytes / VLM_SCHEMA_BYTES_PER_TOKEN);
  return Math.min(
    VLM_OUTPUT_TOKEN_BUDGET_HARD_MAX,
    Math.max(1, Number.isSafeInteger(estimate) ? estimate : 1),
  );
}

/**
 * Resolve one bounded output token budget for the initial call and its
 * optional repair. The frame count and schema shape affect the request, while
 * the policy value remains the hard per-call ceiling.
 */
export function computeVlmOutputTokenBudget(
  frameCount: number,
  schema: Record<string, unknown> = getVlmProviderResponseSchema(),
  maxOutputTokens: number = VLM_OUTPUT_TOKEN_BUDGET_DEFAULT_MAX,
): number {
  const configuredMax = Number.isSafeInteger(maxOutputTokens) && maxOutputTokens > 0
    ? maxOutputTokens
    : VLM_OUTPUT_TOKEN_BUDGET_DEFAULT_MAX;
  const hardMax = Math.min(configuredMax, VLM_OUTPUT_TOKEN_BUDGET_HARD_MAX);
  const normalizedFrameCount = Number.isSafeInteger(frameCount) && frameCount > 0
    ? Math.min(frameCount, VLM_OUTPUT_TOKEN_BUDGET_HARD_MAX)
    : 0;
  const estimated = estimateVlmSchemaOutputTokens(schema) +
    normalizedFrameCount * VLM_OUTPUT_TOKENS_PER_FRAME;
  const rounded = Math.ceil(estimated / VLM_OUTPUT_TOKEN_ROUNDING) * VLM_OUTPUT_TOKEN_ROUNDING;
  return Math.min(
    hardMax,
    Math.max(1, Math.min(VLM_OUTPUT_TOKEN_BUDGET_MIN, hardMax), rounded),
  );
}

/**
 * Compute evenly-spaced sample timestamps (in microseconds) within a segment window.
 * Returns timestamps that lie within [srcInUs, srcOutUs).
 */
export function computeSampleTimestamps(
  srcInUs: number,
  srcOutUs: number,
  frameCount: number,
): number[] {
  if (frameCount <= 0) return [];
  if (frameCount === 1) {
    // Midpoint-biased single frame
    return [Math.floor((srcInUs + srcOutUs) / 2)];
  }
  const duration = srcOutUs - srcInUs;
  const step = duration / frameCount;
  const timestamps: number[] = [];
  for (let i = 0; i < frameCount; i++) {
    // Place frames at the center of each evenly-divided slot
    timestamps.push(Math.floor(srcInUs + step * i + step / 2));
  }
  return timestamps;
}

/**
 * Reduce sample FPS to fit within the token budget.
 * Returns adjusted FPS (may be lower than the policy default).
 */
export function adjustFpsForBudget(
  durationUs: number,
  baseFps: number,
  frameCap: number,
  tokenBudgetMax: number,
  /** Estimated tokens per frame (default: ~258 tokens for a 1024px JPEG). */
  tokensPerFrame: number = 258,
): number {
  const frameCount = computeFrameCount(durationUs, baseFps, frameCap);
  const estimatedTokens = frameCount * tokensPerFrame;
  if (estimatedTokens <= tokenBudgetMax) return baseFps;

  // Reduce FPS proportionally
  const maxFrames = Math.floor(tokenBudgetMax / tokensPerFrame);
  if (maxFrames <= 0) return 0;
  const durationSec = durationUs / 1_000_000;
  return Math.max(0.1, maxFrames / durationSec);
}

// ── Output Normalization ───────────────────────────────────────────

/**
 * Normalize a string to lower_snake_case for tag normalization.
 */
export function toSnakeCase(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * Normalize and deduplicate tags. Caps at maxTags.
 */
export function normalizeTags(raw: unknown[], maxTags: number = 20): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const normalized = toSnakeCase(item);
    if (normalized.length === 0) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
    if (result.length >= maxTags) break;
  }
  return result;
}

/**
 * Normalize quality flags to the repository vocabulary.
 * Unknown flags are dropped; aliases are mapped.
 */
export function normalizeQualityFlags(raw: unknown[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const snake = toSnakeCase(item);
    // Direct vocabulary match
    let canonical = QUALITY_FLAG_VOCABULARY.has(snake) ? snake : undefined;
    // Alias lookup
    if (!canonical && QUALITY_FLAG_ALIASES[snake]) {
      canonical = QUALITY_FLAG_ALIASES[snake];
    }
    if (!canonical) continue;
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    result.push(canonical);
  }
  return result;
}

/**
 * Normalize interest points: clamp to segment bounds, validate types.
 */
export function normalizeInterestPoints(
  raw: Array<{ frame_us?: unknown; label?: unknown; confidence?: unknown }>,
  srcInUs: number,
  srcOutUs: number,
): Array<{ frame_us: number; label: string; confidence: number }> {
  const result: Array<{ frame_us: number; label: string; confidence: number }> = [];
  for (const pt of raw) {
    if (typeof pt.frame_us !== "number" || typeof pt.label !== "string") continue;
    const frameUs = Math.round(pt.frame_us);
    if (frameUs < srcInUs || frameUs > srcOutUs) continue;
    const conf = typeof pt.confidence === "number"
      ? Math.max(0, Math.min(1, pt.confidence))
      : 0.5;
    const label = pt.label.trim();
    if (label.length === 0) continue;
    result.push({ frame_us: frameUs, label, confidence: conf });
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clampScore(value: unknown, fallback = 0.5): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(1, value));
}

function normalizeLabelArray(value: unknown): string[] {
  return Array.isArray(value) ? normalizeTags(value) : [];
}

function normalizeVisualQuality(raw: unknown): VlmVisualQuality | undefined {
  if (!isRecord(raw)) return undefined;

  const scoresRaw = isRecord(raw.scores) ? raw.scores : {};
  const labelsRaw = isRecord(raw.labels) ? raw.labels : {};

  return {
    scores: {
      light_quality: clampScore(scoresRaw.light_quality),
      subject_prominence: clampScore(scoresRaw.subject_prominence),
      emotional_expression: clampScore(scoresRaw.emotional_expression),
      composition_score: clampScore(scoresRaw.composition_score),
      motion_quality: clampScore(scoresRaw.motion_quality),
    },
    labels: {
      lighting_style: normalizeLabelArray(labelsRaw.lighting_style),
      composition_tags: normalizeLabelArray(labelsRaw.composition_tags),
      expression_tags: normalizeLabelArray(labelsRaw.expression_tags),
      motion_tags: normalizeLabelArray(labelsRaw.motion_tags),
    },
  };
}

const OBSERVATION_ENUMS = {
  motion_type: ["static", "subtle", "continuous", "intermittent", "rapid", "mixed", "unknown", "not_applicable"],
  camera_motion_direction: ["left", "right", "up", "down", "toward_camera", "away_from_camera", "mixed", "unknown", "not_applicable"],
  subject_motion_direction: ["left", "right", "up", "down", "toward_camera", "away_from_camera", "mixed", "unknown", "not_applicable"],
  shot_scale: ["extreme_wide", "wide", "medium_wide", "medium", "medium_close_up", "close_up", "extreme_close_up", "insert", "unknown", "not_applicable"],
  composition_anchor: ["left", "center", "right", "balanced", "multiple", "full_frame", "unknown", "not_applicable"],
  screen_side: ["left", "center", "right", "multiple", "full_frame", "unknown", "not_applicable"],
  gaze_direction: ["screen_left", "screen_right", "camera", "away", "up", "down", "mixed", "unknown", "not_applicable"],
  camera_axis: ["axis_left", "axis_right", "on_axis", "establishing", "unknown", "not_applicable"],
  dominant_subject_type: ["person", "group", "animal", "object", "landscape", "architecture", "text_graphic", "mixed", "unknown", "not_applicable"],
  text_presence: ["present", "absent", "unknown", "not_applicable"],
} as const;

function normalizeEditorialObservation(raw: unknown): VlmNormalizedOutput["editorial_observation"] {
  if (!isRecord(raw)) return undefined;
  const values: Record<string, unknown> = {};
  if (Array.isArray(raw.visual_tags)) values.visual_tags = normalizeTags(raw.visual_tags);
  if (Array.isArray(raw.dominant_colors)) values.dominant_colors = normalizeTags(raw.dominant_colors);
  for (const [field, allowed] of Object.entries(OBSERVATION_ENUMS)) {
    if (!Object.prototype.hasOwnProperty.call(raw, field)) continue;
    const value = raw[field];
    values[field] = typeof value === "string" && (allowed as readonly string[]).includes(value)
      ? value
      : "unknown";
  }
  const confidenceRaw = isRecord(raw.confidence) ? raw.confidence : {};
  const confidence: Record<string, number> = {};
  for (const group of ["tags", "motion", "framing", "direction", "appearance", "text"] as const) {
    const value = confidenceRaw[group];
    if (typeof value === "number" && Number.isFinite(value)) {
      confidence[group] = clampScore(value);
    }
  }
  return { values: values as ObservationValues, confidence };
}

/**
 * Normalize the full VLM response into a clean output.
 */
export function normalizeVlmOutput(
  raw: VlmRawResponse,
  srcInUs: number,
  srcOutUs: number,
): VlmNormalizedOutput {
  const summary = typeof raw.summary === "string"
    ? raw.summary.trim().slice(0, 500)
    : "";

  const tags = normalizeTags(Array.isArray(raw.tags) ? raw.tags : []);

  const interestPoints = normalizeInterestPoints(
    Array.isArray(raw.interest_points) ? raw.interest_points : [],
    srcInUs,
    srcOutUs,
  );

  const qualityFlags = normalizeQualityFlags(
    Array.isArray(raw.quality_flags) ? raw.quality_flags : [],
  );

  const confidence = {
    summary: typeof raw.confidence?.summary === "number"
      ? Math.max(0, Math.min(1, raw.confidence.summary))
      : 0.5,
    tags: typeof raw.confidence?.tags === "number"
      ? Math.max(0, Math.min(1, raw.confidence.tags))
      : 0.5,
    quality_flags: typeof raw.confidence?.quality_flags === "number"
      ? Math.max(0, Math.min(1, raw.confidence.quality_flags))
      : 0.5,
  };

  const visualQuality = normalizeVisualQuality(raw.visual_quality);
  const editorialObservation = normalizeEditorialObservation(raw.editorial_observation);

  return {
    summary,
    tags,
    interest_points: interestPoints,
    quality_flags: qualityFlags,
    confidence,
    ...(visualQuality ? { visual_quality: visualQuality } : {}),
    ...(editorialObservation ? { editorial_observation: editorialObservation } : {}),
  };
}

// ── Parse Retry ────────────────────────────────────────────────────

/** Stable failure code for responses that parse but carry no usable content. */
export const VLM_EMPTY_RESPONSE_ERROR = "vlm_semantically_empty_response";

/**
 * Stable failure code for parse failures. JSON.parse error messages can embed
 * fragments of the raw provider body, so the raw message is never propagated.
 */
export const VLM_PARSE_FAILED_ERROR = "vlm_parse_failed";

/** Stable failure code for JSON that parses but violates the canonical schema. */
export const VLM_SCHEMA_VALIDATION_ERROR = "vlm_schema_validation_failed";

/** Stable failure code for provider- or EOF-truncated JSON output. */
export const VLM_TRUNCATED_RESPONSE_ERROR = "vlm_response_truncated";

/**
 * Stable failure code for arbitrary provider/runtime throws. Their messages
 * are untrusted and may echo raw bodies or secrets, so only this code is
 * recorded. Known-safe connector diagnostics and deadline/cancel errors are
 * handled in classifyVlmCallError.
 */
export const VLM_CALL_FAILED_ERROR = "vlm_call_failed";

/** Fixed non-secret code for deadline (TimeoutError) surfaces. */
export const VLM_DEADLINE_EXCEEDED_ERROR = "vlm_deadline_exceeded";

/** Fixed non-secret code for cancel/abort (AbortError) surfaces. */
export const VLM_CANCELLED_ERROR = "vlm_cancelled";

/** Provider placeholder enum values that convey no semantic content. */
const OBSERVATION_PLACEHOLDER_VALUES = new Set(["unknown", "not_applicable"]);

/** Canonical visual_quality score keys per segments.schema.json. */
const VISUAL_QUALITY_SCORE_KEYS = [
  "light_quality",
  "subject_prominence",
  "emotional_expression",
  "composition_score",
  "motion_quality",
] as const;

/** Canonical visual_quality label keys per segments.schema.json. */
const VISUAL_QUALITY_LABEL_KEYS = [
  "lighting_style",
  "composition_tags",
  "expression_tags",
  "motion_tags",
] as const;

/** Known Gemini finishReason enum values safe to record in diagnostics. */
const GEMINI_FINISH_REASONS = new Set([
  "STOP",
  "MAX_TOKENS",
  "SAFETY",
  "RECITATION",
  "LANGUAGE",
  "OTHER",
  "BLOCKLIST",
  "PROHIBITED_CONTENT",
  "SPII",
  "MALFORMED_FUNCTION_CALL",
  // Kept as a safe adapter value for providers that surface an EOF reason.
  "EOF",
]);

const GEMINI_BLOCK_REASONS = new Set([
  "SAFETY",
  "OTHER",
  "BLOCKLIST",
  "PROHIBITED_CONTENT",
]);

/** Practical ceiling for any provider-derived count retained in diagnostics. */
export const VLM_DIAGNOSTIC_COUNT_MAX = 1_000_000;

const DIAGNOSTIC_TOP_LEVEL_KEYS = new Set([
  "confidence",
  "editorial_observation",
  "interest_points",
  "quality_flags",
  "summary",
  "tags",
  "visual_quality",
]);

class GeminiVlmResponseError extends Error {
  constructor(
    message: string,
    readonly parseStage: VlmParseStage,
    readonly responseDiagnostic: VlmResponseDiagnostic,
    readonly responseScope: VlmParseDiagnostic["response_scope"] = "candidate_text",
    readonly jsonErrorOffset?: number,
  ) {
    super(message);
    this.name = "GeminiVlmResponseError";
  }
}

function boundedCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) &&
      value >= 0 && value <= VLM_DIAGNOSTIC_COUNT_MAX
    ? value
    : null;
}

function allowlistedEnum(value: unknown, allowed: ReadonlySet<string>): string | null {
  if (typeof value !== "string") return null;
  return allowed.has(value) ? value : "unrecognized";
}

function allowlistedFinishReason(value: unknown): VlmFinishReason | null {
  return allowlistedEnum(value, GEMINI_FINISH_REASONS) as VlmFinishReason | null;
}

/**
 * Classify only the two bounded truncation signals understood by this
 * connector. An unclosed object is the EOF-equivalent fallback when the
 * provider does not return a finish reason.
 */
export function classifyVlmTruncationReason(
  rawJson: string,
  finishReason?: unknown,
): VlmTruncationReason | null {
  if (finishReason === "MAX_TOKENS") return "max_tokens";
  if (finishReason === "EOF") return "eof";
  const firstBrace = rawJson.indexOf("{");
  const lastBrace = rawJson.lastIndexOf("}");
  if (firstBrace < 0) return null;
  if (hasUnclosedJsonStructure(rawJson, firstBrace)) return "eof";
  if (lastBrace === -1 || lastBrace <= firstBrace) return "eof";
  try {
    JSON.parse(rawJson.slice(firstBrace, lastBrace + 1));
    return null;
  } catch (error) {
    // JSON.parse's EOF/unterminated-string diagnostics are used only as a
    // classification signal; the provider text is never returned or stored.
    return error instanceof SyntaxError &&
      /unexpected end|end of json input|unterminated string/i.test(error.message)
      ? "eof"
      : null;
  }
}

function hasUnclosedJsonStructure(rawJson: string, start: number): boolean {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (let index = start; index < rawJson.length; index += 1) {
    const character = rawJson[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
    } else if (character === "{" || character === "[") {
      stack.push(character);
    } else if (character === "}" || character === "]") {
      const opener = stack.pop();
      if ((character === "}" && opener !== "{") ||
        (character === "]" && opener !== "[")) {
        return false;
      }
    }
  }
  return inString || stack.length > 0;
}

const RESPONSE_PART_KINDS: ReadonlySet<VlmResponsePartKind> = new Set([
  "text",
  "thought_text",
  "inline_data",
  "file_data",
  "function_call",
  "function_response",
  "executable_code",
  "code_execution_result",
  "empty",
  "unknown",
  "unavailable",
]);

function safeResponsePartKind(value: unknown): VlmResponsePartKind {
  return typeof value === "string" && RESPONSE_PART_KINDS.has(value as VlmResponsePartKind)
    ? value as VlmResponsePartKind
    : "unknown";
}

function responseTextMetadata(rawJson: string, outputTokenCap: number): Pick<
  VlmResponseDiagnostic,
  "output_token_cap" | "text_bytes" | "text_sha256_16" |
  "has_open_brace" | "ends_with_close_brace"
> {
  const trimmed = rawJson.trim();
  return {
    output_token_cap: Number.isSafeInteger(outputTokenCap) && outputTokenCap >= 0 &&
        outputTokenCap <= VLM_OUTPUT_TOKEN_BUDGET_HARD_MAX
      ? outputTokenCap
      : 0,
    text_bytes: boundedCount(Buffer.byteLength(rawJson)),
    text_sha256_16: createHash("sha256").update(rawJson).digest("hex").slice(0, 16),
    has_open_brace: rawJson.includes("{"),
    ends_with_close_brace: trimmed.endsWith("}"),
  };
}

function fallbackResponseDiagnostic(
  rawJson: string,
  outputTokenCap: number,
  inferTruncation = true,
): VlmResponseDiagnostic {
  return {
    candidate_count: null,
    finish_reason: null,
    block_reason: null,
    blocked: false,
    candidates_token_count: null,
    thoughts_token_count: null,
    ...responseTextMetadata(rawJson, outputTokenCap),
    part_count: null,
    text_part_count: null,
    first_part_kind: "unavailable",
    truncation_reason: inferTruncation ? classifyVlmTruncationReason(rawJson) : null,
  };
}

/** Rebuild provider metadata at the connector boundary without raw values. */
function sanitizeResponseDiagnostic(
  rawJson: string,
  outputTokenCap: number,
  diagnostic?: VlmResponseDiagnostic,
): VlmResponseDiagnostic {
  const fallback = fallbackResponseDiagnostic(rawJson, outputTokenCap);
  if (!diagnostic) return fallback;
  const truncationReason = classifyVlmTruncationReason(rawJson, diagnostic.finish_reason) ??
    (diagnostic.truncation_reason === "max_tokens" || diagnostic.truncation_reason === "eof"
      ? diagnostic.truncation_reason
      : null);
  return {
    candidate_count: boundedCount(diagnostic.candidate_count),
    finish_reason: allowlistedFinishReason(diagnostic.finish_reason),
    block_reason: allowlistedEnum(diagnostic.block_reason, GEMINI_BLOCK_REASONS),
    blocked: diagnostic.blocked === true,
    candidates_token_count: boundedCount(diagnostic.candidates_token_count),
    thoughts_token_count: boundedCount(diagnostic.thoughts_token_count),
    ...responseTextMetadata(rawJson, outputTokenCap),
    part_count: boundedCount(diagnostic.part_count),
    text_part_count: boundedCount(diagnostic.text_part_count),
    first_part_kind: safeResponsePartKind(diagnostic.first_part_kind),
    truncation_reason: truncationReason,
  };
}

function firstPartKind(part: Record<string, unknown> | undefined): VlmResponsePartKind {
  if (!part || Object.keys(part).length === 0) return "empty";
  if (part.thought === true && typeof part.text === "string") return "thought_text";
  if (typeof part.text === "string") return "text";
  if (isRecord(part.inlineData) || isRecord(part.inline_data)) return "inline_data";
  if (isRecord(part.fileData) || isRecord(part.file_data)) return "file_data";
  if (isRecord(part.functionCall) || isRecord(part.function_call)) return "function_call";
  if (isRecord(part.functionResponse) || isRecord(part.function_response)) return "function_response";
  if (isRecord(part.executableCode) || isRecord(part.executable_code)) return "executable_code";
  if (isRecord(part.codeExecutionResult) || isRecord(part.code_execution_result)) {
    return "code_execution_result";
  }
  return "unknown";
}

function presentTopLevelKeys(parsed: unknown): string[] | undefined {
  if (!isRecord(parsed)) return undefined;
  const keys = Object.keys(parsed)
    .filter((key) => DIAGNOSTIC_TOP_LEVEL_KEYS.has(key))
    .sort();
  return keys.length > 0 ? keys : undefined;
}

function jsonErrorOffset(error: unknown): number | undefined {
  if (!(error instanceof SyntaxError)) return undefined;
  const match = error.message.match(/position\s+(\d+)/i);
  if (!match) return undefined;
  return boundedCount(Number(match[1])) ?? undefined;
}

function parseFailureStage(rawJson: string): "no_json_span" | "truncated_json" | "json_syntax_error" {
  const firstBrace = rawJson.indexOf("{");
  const lastBrace = rawJson.lastIndexOf("}");
  if (firstBrace === -1) return "no_json_span";
  if (classifyVlmTruncationReason(rawJson) === "eof") return "truncated_json";
  if (lastBrace <= firstBrace) return "truncated_json";
  return "json_syntax_error";
}

function isMeaningfulObservationValue(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((item) =>
      typeof item === "string" &&
      item.trim().length > 0 &&
      !OBSERVATION_PLACEHOLDER_VALUES.has(item.trim().toLowerCase()),
    );
  }
  return typeof value === "string" &&
    value.trim().length > 0 &&
    !OBSERVATION_PLACEHOLDER_VALUES.has(value);
}

/**
 * Whether a raw visual_quality label string is meaningful after the same
 * snake-case normalization the output pipeline applies.
 */
function isMeaningfulVisualQualityLabel(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const normalized = toSnakeCase(value);
  return normalized.length > 0 &&
    !OBSERVATION_PLACEHOLDER_VALUES.has(normalized);
}

/**
 * Whether the raw visual_quality payload carried at least one valid score or
 * label under a canonical schema key. Unknown keys are ignored, numeric
 * scores must be finite and within the schema's 0..1 range, and the
 * fallback-normalized 0.5 scores are never used as semantic evidence.
 */
function hasMeaningfulVisualQualityValues(raw: unknown): boolean {
  if (!isRecord(raw)) return false;
  const scoresRaw = isRecord(raw.scores) ? raw.scores : {};
  for (const key of VISUAL_QUALITY_SCORE_KEYS) {
    const value = scoresRaw[key];
    if (
      typeof value === "number" && Number.isFinite(value) &&
      value >= 0 && value <= 1
    ) return true;
  }
  const labelsRaw = isRecord(raw.labels) ? raw.labels : {};
  return VISUAL_QUALITY_LABEL_KEYS.some((key) => {
    const value = labelsRaw[key];
    return Array.isArray(value) &&
      value.some(isMeaningfulVisualQualityLabel);
  });
}

/**
 * Whether a normalized VLM output carries any semantic content at all.
 * An empty summary/tags/interest_points/quality_flags plus an absent or
 * placeholder-only editorial_observation/visual_quality conveys nothing and
 * must not be treated as a successful (cacheable) enrichment result.
 */
export function isSemanticallyEmptyVlmOutput(
  output: VlmNormalizedOutput,
  raw?: VlmRawResponse,
): boolean {
  return output.summary.length === 0 &&
    output.tags.length === 0 &&
    output.interest_points.length === 0 &&
    output.quality_flags.length === 0 &&
    !hasMeaningfulObservationValues(output.editorial_observation) &&
    !hasMeaningfulVisualQualityValues(raw?.visual_quality);
}

function hasMeaningfulObservationValues(
  observation: VlmNormalizedOutput["editorial_observation"],
): boolean {
  if (!observation) return false;
  return Object.values(observation.values).some(isMeaningfulObservationValue);
}

// ── Error Classification ───────────────────────────────────────────

/** Fixed grounding-guard codes with no variable content. */
const SAFE_VLM_ERROR_CODES = new Set([
  "grounded_vlm_requires_at_least_one_image",
  "grounded_vlm_empty_candidate_text",
]);

/**
 * Exact-match HTTP diagnostic emitted by createGeminiVlmFn: status plus
 * byte-count/hash only, never the response body.
 */
const SAFE_HTTP_ERROR_PATTERN =
  /^Gemini API error \d+: response_bytes=\d+;response_sha256=[0-9a-f]{16}$/;

const EMPTY_CANDIDATE_ERROR_PREFIX = "grounded_vlm_empty_candidate_text:";

/**
 * Exact-match check for the empty-candidate code optionally carrying a known
 * finishReason enum. Unknown suffixes (or trailing content) never match, so
 * external throws cannot borrow the safe prefix to smuggle a body through.
 */
function isSafeEmptyCandidateErrorCode(message: string): boolean {
  if (!message.startsWith(EMPTY_CANDIDATE_ERROR_PREFIX)) return false;
  return GEMINI_FINISH_REASONS.has(
    message.slice(EMPTY_CANDIDATE_ERROR_PREFIX.length),
  );
}

/**
 * Map a thrown VLM call error to a stable, non-secret failure string.
 * JSON.parse failures collapse to vlm_parse_failed and arbitrary provider /
 * runtime throws collapse to vlm_call_failed because their messages can quote
 * raw provider text. Deadline/cancel surfaces through the well-known
 * AbortError/TimeoutError names and convert to fixed codes; message bodies
 * are never re-emitted. Only connector-controlled diagnostics with fully
 * determined shapes (exact codes or the exact HTTP pattern) pass through.
 */
function classifyVlmCallError(err: unknown): string {
  if (!(err instanceof Error)) return VLM_CALL_FAILED_ERROR;
  if (err instanceof GeminiVlmResponseError) return err.message;
  if (err.name === "TimeoutError") return VLM_DEADLINE_EXCEEDED_ERROR;
  if (err.name === "AbortError") return VLM_CANCELLED_ERROR;
  if (
    err instanceof SyntaxError ||
    err.message.includes("No JSON object found")
  ) {
    return VLM_PARSE_FAILED_ERROR;
  }
  // Variable-suffix guard: keep only the fixed non-secret code, dropping the
  // offending frame paths.
  if (err.message.startsWith("grounded_vlm_invalid_image_paths")) {
    return "grounded_vlm_invalid_image_paths";
  }
  if (
    SAFE_VLM_ERROR_CODES.has(err.message) ||
    isSafeEmptyCandidateErrorCode(err.message) ||
    SAFE_HTTP_ERROR_PATTERN.test(err.message)
  ) {
    return err.message;
  }
  return VLM_CALL_FAILED_ERROR;
}

/**
 * Attempt to parse a raw JSON string from the VLM into VlmRawResponse.
 * Strips markdown fences and leading/trailing noise.
 */
export function parseVlmJson(raw: string): VlmRawResponse {
  // Strip markdown code fences if present
  let cleaned = raw.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
  }
  // Find the first { and last }
  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    throw new Error("No JSON object found in VLM response");
  }
  cleaned = cleaned.slice(firstBrace, lastBrace + 1);
  return JSON.parse(cleaned) as VlmRawResponse;
}

// ── Segment Enrichment ─────────────────────────────────────────────

/** Hard quality flags that make a segment unusable for VLM. */
const HARD_SKIP_FLAGS = new Set(["black_segment"]);

/**
 * Determine whether a segment should be skipped for VLM enrichment.
 */
export function shouldSkipVlm(
  qualityFlags: string[],
  durationUs: number,
  minDurationUs: number,
): boolean {
  // Skip if segment is too short
  if (durationUs < minDurationUs) return true;
  // Skip if marked unusable by hard flags
  for (const flag of qualityFlags) {
    if (HARD_SKIP_FLAGS.has(flag)) return true;
  }
  return false;
}

/**
 * Build the full prompt for a segment VLM call.
 */
export function buildSegmentPrompt(transcriptContext?: string, contentHint?: string): string {
  let prompt = PROMPT_TEMPLATE;
  if (contentHint && contentHint.length > 0) {
    prompt += `\n\nContent context: This footage depicts ${contentHint}. Use this context to improve recognition accuracy.`;
  }
  if (transcriptContext && transcriptContext.length > 0) {
    prompt += `\n\nTranscript context for this segment:\n${transcriptContext}`;
  }
  return prompt;
}

/**
 * Build the bounded repair request from validator output only. The original
 * response, transcript, content hint, and provider diagnostics are excluded
 * so a repair cannot echo them into the provider request or a receipt.
 */
export function buildVlmRepairPrompt(validationErrors: VlmValidationError[] = []): string {
  const safeErrors = validationErrors.length > 0
    ? validationErrors
    : getVlmRequiredPaths().map((pathValue) => ({
      path: pathValue,
      code: "missing" as const,
      kind: "missing" as const,
      keyword: "required",
      expected: "required property",
    }));
  const uniqueLines = [...new Set(safeErrors.map(formatVlmValidationError))];
  return [
    REPAIR_PROMPT_PREFIX,
    ...uniqueLines.map((line) => `- ${line}`),
    "Return only the repaired canonical object. Do not change the supplied source/frame identity, frame count, or frame set.",
    "No markdown, explanation, raw output, or extra properties.",
  ].join("\n");
}

/**
 * Enrich a single segment with VLM output.
 * Handles parse retry and gap fallback internally.
 */
export async function enrichSegment(
  vlmFn: VlmFn,
  framePaths: string[],
  srcInUs: number,
  srcOutUs: number,
  vlmPolicy: VlmPolicy,
  transcriptContext?: string,
  contentHint?: string,
): Promise<VlmEnrichmentResult> {
  const promptHash = computePromptHash();
  const prompt = buildSegmentPrompt(transcriptContext, contentHint);
  // Snapshot the caller's grounded frame set once. Every provider attempt,
  // including repair, receives a fresh array with the same ordered identity.
  const groundedFramePaths = framePaths.slice();
  const responseSchema = getVlmProviderResponseSchema();
  const requestedOutputTokens = computeVlmOutputTokenBudget(
    groundedFramePaths.length,
    responseSchema,
    vlmPolicy.segment_visual_output_tokens_max,
  );
  let lastError: string | undefined;
  let lastFinishReason: VlmFinishReason | null = null;
  let retryReason: VlmRetryReason | null = null;
  const parseDiagnostics: VlmParseDiagnostic[] = [];
  let attempt = 0;
  let repairUsed = false;
  let repairValidationErrors: VlmValidationError[] = [];

  while (true) {
    let result: VlmCallResult | undefined;
    let responseDiagnostic: VlmResponseDiagnostic | undefined;
    try {
      const callPrompt = attempt === 0
        ? prompt
        : buildVlmRepairPrompt(repairValidationErrors);
      lastFinishReason = null;
      result = await vlmFn(groundedFramePaths.slice(), callPrompt, {
        model: vlmPolicy.model_alias,
        maxOutputTokens: requestedOutputTokens,
        transcriptContext,
        responseSchema: structuredClone(responseSchema),
      });
      responseDiagnostic = sanitizeResponseDiagnostic(
        result.rawJson,
        requestedOutputTokens,
        result.response_diagnostic,
      );
      lastFinishReason = responseDiagnostic.finish_reason;
      if (responseDiagnostic.truncation_reason) {
        throw new GeminiVlmResponseError(
          VLM_TRUNCATED_RESPONSE_ERROR,
          "truncated_json",
          responseDiagnostic,
        );
      }

      const parsed = parseVlmJson(result.rawJson);
      const validation = validateVlmGroundingResponse(parsed);
      if (!validation.valid) {
        lastError = VLM_SCHEMA_VALIDATION_ERROR;
        repairValidationErrors = validation.errors;
        parseDiagnostics.push({
          attempt_index: attempt,
          attempt_outcome: "parse_failure",
          error_code: lastError,
          parse_stage: "schema_invalid",
          response_scope: "candidate_text",
          ...(presentTopLevelKeys(parsed)
            ? { present_top_level_keys: presentTopLevelKeys(parsed) }
            : {}),
          validation_errors: validation.errors,
          response: responseDiagnostic,
        });
        if (shouldRetryVlmParse(vlmPolicy, repairUsed)) {
          retryReason = "schema_invalid";
          repairUsed = true;
          attempt += 1;
          continue;
        }
        break;
      }

      const normalized = normalizeVlmOutput(parsed, srcInUs, srcOutUs);

      // Empty payloads must never be cached as success. Consume the remaining
      // bounded repair attempt only; if it is still empty, fall through to the
      // failure result below so the existing gap/coverage path takes over.
      if (isSemanticallyEmptyVlmOutput(normalized, parsed)) {
        lastError = VLM_EMPTY_RESPONSE_ERROR;
        parseDiagnostics.push({
          attempt_index: attempt,
          attempt_outcome: "parse_failure",
          error_code: lastError,
          parse_stage: "schema_empty",
          response_scope: "candidate_text",
          ...(presentTopLevelKeys(parsed)
            ? { present_top_level_keys: presentTopLevelKeys(parsed) }
            : {}),
          response: responseDiagnostic,
        });
        if (shouldRetryVlmParse(vlmPolicy, repairUsed)) {
          retryReason = "schema_empty";
          repairUsed = true;
          attempt += 1;
          continue;
        }
        break;
      }

      return {
        success: true,
        output: normalized,
        prompt_hash: promptHash,
        model_alias: vlmPolicy.model_alias,
        model_snapshot: vlmPolicy.model_snapshot,
        requested_output_tokens: requestedOutputTokens,
        finish_reason: lastFinishReason,
        attempt_count: attempt + 1,
        retry_reason: retryReason,
        ...(parseDiagnostics.some((item) => item.attempt_outcome === "call_failure")
          ? { parse_diagnostics: parseDiagnostics }
          : {}),
      };
    } catch (err) {
      lastError = classifyVlmCallError(err);
      if (err instanceof GeminiVlmResponseError) {
        const safeDiagnostic = result
          ? sanitizeResponseDiagnostic(result.rawJson, requestedOutputTokens, err.responseDiagnostic)
          : err.responseDiagnostic;
        lastFinishReason = safeDiagnostic.finish_reason;
        parseDiagnostics.push({
          attempt_index: attempt,
          attempt_outcome: "parse_failure",
          error_code: lastError,
          parse_stage: err.parseStage,
          response_scope: err.responseScope,
          ...(err.jsonErrorOffset !== undefined
            ? { json_error_offset: err.jsonErrorOffset }
            : {}),
          response: safeDiagnostic,
        });
      } else if (lastError === VLM_PARSE_FAILED_ERROR && result) {
        const offset = jsonErrorOffset(err);
        const parseStage = parseFailureStage(result.rawJson);
        const diagnostic = responseDiagnostic ?? sanitizeResponseDiagnostic(
          result.rawJson,
          requestedOutputTokens,
          result.response_diagnostic,
        );
        if (parseStage === "truncated_json" || diagnostic.truncation_reason) {
          lastError = VLM_TRUNCATED_RESPONSE_ERROR;
        }
        parseDiagnostics.push({
          attempt_index: attempt,
          attempt_outcome: "parse_failure",
          error_code: lastError,
          parse_stage: parseStage,
          response_scope: "candidate_text",
          ...(offset !== undefined ? { json_error_offset: offset } : {}),
          response: diagnostic,
        });
      } else {
        parseDiagnostics.push({
          attempt_index: attempt,
          attempt_outcome: "call_failure",
          error_code: lastError,
        });
      }
      if (shouldRetryVlmParse(vlmPolicy, repairUsed)) {
        retryReason = retryReasonForFailure(
          lastError,
          parseDiagnostics[parseDiagnostics.length - 1]?.parse_stage,
          parseDiagnostics[parseDiagnostics.length - 1]?.response,
          parseDiagnostics[parseDiagnostics.length - 1]?.attempt_outcome,
        );
        repairUsed = true;
        attempt += 1;
        continue;
      }
      break;
    }
  }

  // Gap fallback: return failure, segments keep existing fields
  return {
    success: false,
    error: lastError ?? "vlm_call_failed",
    ...(parseDiagnostics.length > 0
      ? { parse_diagnostics: parseDiagnostics }
      : {}),
    prompt_hash: promptHash,
    model_alias: vlmPolicy.model_alias,
    model_snapshot: vlmPolicy.model_snapshot,
    requested_output_tokens: requestedOutputTokens,
    finish_reason: lastFinishReason,
    attempt_count: attempt + 1,
    retry_reason: retryReason,
  };
}

function shouldRetryVlmParse(vlmPolicy: VlmPolicy, repairUsed: boolean): boolean {
  return !repairUsed && Number.isFinite(vlmPolicy.parse_retry_max) &&
    vlmPolicy.parse_retry_max > 0;
}

function retryReasonForFailure(
  errorCode: string,
  parseStage: VlmParseStage | undefined,
  responseDiagnostic: VlmResponseDiagnostic | undefined,
  attemptOutcome: VlmParseDiagnostic["attempt_outcome"] | undefined,
): VlmRetryReason {
  if (responseDiagnostic?.truncation_reason || parseStage === "truncated_json" ||
    errorCode === VLM_TRUNCATED_RESPONSE_ERROR) {
    return "truncated_json";
  }
  if (parseStage === "no_candidate" || parseStage === "no_text" ||
    parseStage === "no_json_span" || parseStage === "json_syntax_error" ||
    parseStage === "schema_invalid" || parseStage === "schema_empty") {
    return parseStage;
  }
  return attemptOutcome === "call_failure" ? "call_failure" : "json_syntax_error";
}

// ── Role Guess ─────────────────────────────────────────────────────

/**
 * Guess the editorial role of an asset based on combined STT + VLM evidence.
 * Returns: "interview" | "b-roll" | "texture" | "hybrid" | "unknown"
 */
export function guessAssetRole(
  hasTranscript: boolean,
  segments: Array<{
    segment_type: string;
    transcript_excerpt: string;
    tags: string[];
    summary: string;
  }>,
): string {
  if (segments.length === 0) return "unknown";

  const totalSegs = segments.length;
  let dialogueCount = 0;
  let staticCount = 0;
  let actionCount = 0;
  let hasSubstantialSpeech = false;

  for (const seg of segments) {
    if (seg.segment_type === "dialogue") dialogueCount++;
    if (seg.segment_type === "static") staticCount++;
    if (seg.segment_type === "action") actionCount++;
    if (seg.transcript_excerpt && seg.transcript_excerpt.length > 20) {
      hasSubstantialSpeech = true;
    }
  }

  const dialogueRatio = dialogueCount / totalSegs;
  const staticRatio = staticCount / totalSegs;

  // Mostly dialogue + has transcript → interview
  if (hasTranscript && hasSubstantialSpeech && dialogueRatio > 0.5) return "interview";
  // Mostly static or general without speech → texture
  if (staticRatio > 0.7 && !hasSubstantialSpeech) return "texture";
  // Has both speech and visual variety → hybrid
  if (hasTranscript && hasSubstantialSpeech && dialogueRatio <= 0.5) return "hybrid";
  // Action-dominant without speech → b-roll
  if (actionCount > 0 && !hasSubstantialSpeech) return "b-roll";
  // No transcript, general content → b-roll
  if (!hasTranscript && !hasSubstantialSpeech) return "b-roll";

  return "unknown";
}

// ── Default Gemini VlmFn ───────────────────────────────────────────

/**
 * Create the real Gemini VLM function.
 * Requires GEMINI_API_KEY environment variable.
 *
 * NOTE: This is NOT used in tests — tests inject a mock VlmFn.
 */
export function createGeminiVlmFn(): VlmFn {
  return async (framePaths, prompt, options) => {
    const invalidPaths = framePaths.filter((framePath) => {
      if (!path.isAbsolute(framePath)) return true;
      try {
        const stat = fs.statSync(framePath);
        return !stat.isFile() || stat.size <= 0;
      } catch {
        return true;
      }
    });
    if (framePaths.length === 0) {
      throw new Error("grounded_vlm_requires_at_least_one_image");
    }
    if (invalidPaths.length > 0) {
      throw new Error(`grounded_vlm_invalid_image_paths:${invalidPaths.join(",")}`);
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error("GEMINI_API_KEY environment variable is required");
    }

    // Build multipart request with inline image data
    const parts: Array<Record<string, unknown>> = [];

    // Add frame images as inline_data
    for (const framePath of framePaths) {
      const imageData = fs.readFileSync(framePath);
      const base64 = imageData.toString("base64");
      const mimeType = framePath.endsWith(".png") ? "image/png" : "image/jpeg";
      parts.push({
        inline_data: { mime_type: mimeType, data: base64 },
      });
    }

    // Add text prompt
    parts.push({ text: prompt });

    // gemini-2.0-flash was sunset (404 as of 2026-06). Default to the
    // cost-effective vision tier; analysis-defaults.yaml model_alias overrides.
    const model = options.model || "gemini-2.5-flash-lite";
    const responseSchema = options.responseSchema ?? getVlmProviderResponseSchema();
    const outputTokenCap = computeVlmOutputTokenBudget(
      framePaths.length,
      responseSchema,
      options.maxOutputTokens,
    );
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: {
          maxOutputTokens: outputTokenCap,
          temperature: 0.1,
          responseMimeType: "application/json",
          responseSchema,
        },
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      // Never propagate the raw provider body (may echo prompt/secret
      // material); only stable byte-count/hash diagnostics are recorded.
      throw new Error(
        `Gemini API error ${response.status}: response_bytes=${Buffer.byteLength(body)};response_sha256=${createHash("sha256").update(body).digest("hex").slice(0, 16)}`,
      );
    }

    const responseBody = await response.text();
    let data: {
      candidates?: Array<{
        content?: { parts?: Array<Record<string, unknown> & { text?: string }> };
        finishReason?: string;
      }>;
      promptFeedback?: { blockReason?: string };
      usageMetadata?: {
        candidatesTokenCount?: number;
        thoughtsTokenCount?: number;
      };
    };
    try {
      data = JSON.parse(responseBody) as typeof data;
    } catch (error) {
      throw new GeminiVlmResponseError(
        VLM_PARSE_FAILED_ERROR,
        "json_syntax_error",
        fallbackResponseDiagnostic(responseBody, outputTokenCap, false),
        "provider_envelope",
        jsonErrorOffset(error),
      );
    }

    const candidate = data.candidates?.[0];
    const candidateParts = candidate?.content?.parts ?? [];
    const rawJson = candidateParts[0]?.text ?? "";
    const finishReason = allowlistedFinishReason(candidate?.finishReason);
    const blockReason = allowlistedEnum(data.promptFeedback?.blockReason, GEMINI_BLOCK_REASONS);
    const truncationReason = classifyVlmTruncationReason(rawJson, finishReason);
    const responseDiagnostic: VlmResponseDiagnostic = {
      candidate_count: boundedCount(data.candidates?.length ?? 0),
      finish_reason: finishReason,
      block_reason: blockReason,
      blocked: blockReason !== null || finishReason === "SAFETY" ||
        finishReason === "BLOCKLIST" || finishReason === "PROHIBITED_CONTENT" ||
        finishReason === "SPII",
      candidates_token_count: boundedCount(data.usageMetadata?.candidatesTokenCount),
      thoughts_token_count: boundedCount(data.usageMetadata?.thoughtsTokenCount),
      ...responseTextMetadata(rawJson, outputTokenCap),
      part_count: boundedCount(candidateParts.length),
      text_part_count: boundedCount(
        candidateParts.filter((part) => typeof part.text === "string").length,
      ),
      first_part_kind: firstPartKind(candidateParts[0]),
      truncation_reason: truncationReason,
    };
    if (truncationReason) {
      throw new GeminiVlmResponseError(
        VLM_TRUNCATED_RESPONSE_ERROR,
        "truncated_json",
        responseDiagnostic,
      );
    }
    if (!candidate) {
      throw new GeminiVlmResponseError(
        "grounded_vlm_empty_candidate_text",
        "no_candidate",
        responseDiagnostic,
      );
    }
    if (rawJson.trim().length === 0) {
      // A missing/empty candidate is a failed call, not an empty-but-valid
      // "{}" payload. Only known finishReason enum values are recorded;
      // unknown values are omitted rather than echoed into error paths.
      const suffix = finishReason && finishReason !== "unrecognized"
        ? `:${finishReason}`
        : "";
      throw new GeminiVlmResponseError(
        `grounded_vlm_empty_candidate_text${suffix}`,
        "no_text",
        responseDiagnostic,
      );
    }

    return { rawJson, response_diagnostic: responseDiagnostic };
  };
}

// ── Request Hash Helper ────────────────────────────────────────────

/**
 * Compute a request hash for VLM provenance tracking.
 */
export function computeVlmRequestHash(params: {
  segment_id: string;
  model_snapshot: string;
  prompt_hash: string;
  frame_count: number;
  sample_timestamps_us?: number[];
  frame_cache_version?: string;
  requested_output_tokens?: number;
}): string {
  return computeRequestHash(params as unknown as Record<string, unknown>);
}
