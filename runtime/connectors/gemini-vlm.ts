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
import { computeRequestHash } from "./ffprobe.js";

// ── Constants ──────────────────────────────────────────────────────

export const VLM_CONNECTOR_VERSION = "gemini-vlm-v2.0.0";

/** Canonical prompt template for M2 segment enrichment. */
export const PROMPT_TEMPLATE_ID = "m2-segment-v1";

const PROMPT_TEMPLATE = `Analyze the following video segment frames. Return a JSON object with:
- "summary": one short descriptive sentence about what is visually happening
- "tags": array of descriptive tags (lowercase_snake_case, e.g. "outdoor_scene", "close_up")
- "interest_points": array of notable moments, each with "frame_us" (microsecond timestamp), "label" (short description), "confidence" (0-1)
- "quality_flags": array of quality issues detected (from vocabulary: "underexposed", "overexposed", "blurry", "shaky", "noisy", "interlaced", "letterboxed", "pillarboxed")
- "confidence": object with "summary" (0-1), "tags" (0-1), "quality_flags" (0-1)

Respond ONLY with valid JSON, no markdown fences or explanation.`;

const REPAIR_PROMPT = `The previous response was not valid JSON. Please respond with ONLY a valid JSON object matching the schema described earlier. No markdown, no explanation.`;

/** Compute SHA-256 hash of the normalized prompt template + schema version. */
export function computePromptHash(schemaVersion: string = "2.0.0"): string {
  const normalized = PROMPT_TEMPLATE.trim().replace(/\s+/g, " ");
  return createHash("sha256")
    .update(normalized + "|" + schemaVersion)
    .digest("hex")
    .slice(0, 16);
}

/** Compute SHA-256 hash of the repair prompt template. */
export function computeRepairPromptHash(): string {
  const normalized = REPAIR_PROMPT.trim().replace(/\s+/g, " ");
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
    summary?: number;
    tags?: number;
    quality_flags?: number;
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
}

/** Result of a VLM enrichment call for one segment. */
export interface VlmEnrichmentResult {
  success: boolean;
  output?: VlmNormalizedOutput;
  error?: string;
  prompt_hash: string;
  model_alias: string;
  model_snapshot: string;
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
}

export interface VlmCallResult {
  rawJson: string;
  provider_request_id?: string;
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

  return { summary, tags, interest_points: interestPoints, quality_flags: qualityFlags, confidence };
}

// ── Parse Retry ────────────────────────────────────────────────────

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
export function buildSegmentPrompt(transcriptContext?: string): string {
  let prompt = PROMPT_TEMPLATE;
  if (transcriptContext && transcriptContext.length > 0) {
    prompt += `\n\nTranscript context for this segment:\n${transcriptContext}`;
  }
  return prompt;
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
): Promise<VlmEnrichmentResult> {
  const promptHash = computePromptHash();

  const prompt = buildSegmentPrompt(transcriptContext);

  let lastError: string | undefined;

  // Initial call + retry attempts
  const maxAttempts = 1 + vlmPolicy.parse_retry_max;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const callPrompt = attempt === 0 ? prompt : `${prompt}\n\n${REPAIR_PROMPT}`;
      const result = await vlmFn(framePaths, callPrompt, {
        model: vlmPolicy.model_alias,
        maxOutputTokens: vlmPolicy.segment_visual_output_tokens_max,
        transcriptContext,
      });

      const parsed = parseVlmJson(result.rawJson);
      const normalized = normalizeVlmOutput(parsed, srcInUs, srcOutUs);

      return {
        success: true,
        output: normalized,
        prompt_hash: promptHash,
        model_alias: vlmPolicy.model_alias,
        model_snapshot: vlmPolicy.model_snapshot,
      };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }

  // Gap fallback: return failure, segments keep existing fields
  return {
    success: false,
    error: lastError ?? "vlm_call_failed",
    prompt_hash: promptHash,
    model_alias: vlmPolicy.model_alias,
    model_snapshot: vlmPolicy.model_snapshot,
  };
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
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error("GEMINI_API_KEY environment variable is required");
    }

    // Build multipart request with inline image data
    const parts: Array<Record<string, unknown>> = [];

    // Add frame images as inline_data
    for (const framePath of framePaths) {
      if (fs.existsSync(framePath)) {
        const imageData = fs.readFileSync(framePath);
        const base64 = imageData.toString("base64");
        const mimeType = framePath.endsWith(".png") ? "image/png" : "image/jpeg";
        parts.push({
          inline_data: { mime_type: mimeType, data: base64 },
        });
      }
    }

    // Add text prompt
    parts.push({ text: prompt });

    const model = options.model || "gemini-2.0-flash";
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: {
          maxOutputTokens: options.maxOutputTokens,
          temperature: 0.1,
        },
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Gemini API error ${response.status}: ${body}`);
    }

    const data = await response.json() as {
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string }> };
      }>;
    };

    const rawJson = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";

    return { rawJson };
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
}): string {
  return computeRequestHash(params as unknown as Record<string, unknown>);
}
