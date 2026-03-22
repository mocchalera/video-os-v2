/**
 * VLM Peak Detector — Progressive Resolution peak detection via VLM.
 *
 * Per vlm-peak-detection-design.md:
 * - Pass 1 (Coarse): contact sheet → tile-index candidates
 * - Pass 2 (Refine): filmstrip → exact peak center + recommended in/out
 * - Pass 3 (Precision): dense frames → tightened peak (conditional)
 *
 * All VLM calls are injectable for testing.
 * Deterministic normalization — no randomness.
 */

import { createHash } from "node:crypto";
import type { VlmFn, VlmCallResult } from "./gemini-vlm.js";

// ── Constants ──────────────────────────────────────────────────────

export const PEAK_DETECTOR_VERSION = "peak-detector-v1.0.0";

export const COARSE_PROMPT_TEMPLATE_ID = "m2-asset-peak-coarse-v2";
export const REFINE_PROMPT_TEMPLATE_ID = "m2-segment-peak-refine-v2";
export const PRECISION_PROMPT_TEMPLATE_ID = "m2-segment-peak-precision-v1";
export const FUSION_VERSION = "peak-fusion-v1";
export const SUPPORT_SIGNAL_VERSION = "motion-v1";

// ── Types ──────────────────────────────────────────────────────────

export type PeakType = "action_peak" | "emotional_peak" | "visual_peak";

/** Contact sheet tile mapping entry. */
export interface TileMapEntry {
  tile_index: number;
  rep_frame_us: number;
}

/** Filmstrip tile mapping entry (segment-level). */
export interface FilmstripTileEntry {
  tile_index: number;
  frame_us: number;
}

/** Input for Pass 1: Coarse peak discovery. */
export interface CoarseInput {
  asset_id: string;
  contact_sheet_id: string;
  image_path: string;
  tile_map: TileMapEntry[];
  transcript_context?: string;
}

/** Input for Pass 2: Peak refinement. */
export interface RefineInput {
  segment_id: string;
  segment_type: string;
  filmstrip_path: string;
  src_in_us: number;
  src_out_us: number;
  tile_map: FilmstripTileEntry[];
  coarse_hint?: CoarseCandidate;
  transcript_excerpt?: string;
}

/** Input for Pass 3: Precision. */
export interface PrecisionInput {
  segment_id: string;
  segment_type: string;
  frame_paths: string[];
  frame_timestamps_us: number[];
  window_start_us: number;
  window_end_us: number;
  refine_peak_timestamp_us: number;
}

/** Precision mode policy. */
export type PeakPrecisionMode = "action_only" | "always" | "never";

/** Peak detection policy. */
export interface PeakDetectionPolicy {
  peak_precision_mode: PeakPrecisionMode;
  coarse_max_candidates: number;
  refine_max_segments_per_coarse: number;
  max_energy_curve_points: number;
  model_alias: string;
  max_output_tokens: number;
}

export const DEFAULT_PEAK_POLICY: PeakDetectionPolicy = {
  peak_precision_mode: "action_only",
  coarse_max_candidates: 3,
  refine_max_segments_per_coarse: 2,
  max_energy_curve_points: 12,
  model_alias: "gemini-2.0-flash",
  max_output_tokens: 2048,
};

// ── Pass 1: Coarse Output ──────────────────────────────────────────

export interface CoarseCandidate {
  tile_start_index: number;
  tile_end_index: number;
  likely_peak_type: PeakType;
  confidence: number;
  rationale: string;
}

export interface CoarseResult {
  success: boolean;
  candidates: CoarseCandidate[];
  error?: string;
  prompt_hash: string;
}

// ── Pass 2: Refine Output ──────────────────────────────────────────

export interface PeakMoment {
  peak_ref: string;
  timestamp_us: number;
  type: PeakType;
  confidence: number;
  description: string;
  source_pass: "refine_filmstrip" | "precision_dense_frames" | "precision_proxy_clip";
}

export interface RecommendedInOut {
  best_in_us: number;
  best_out_us: number;
  rationale: string;
  source_pass: string;
}

export interface VisualEnergyCurvePoint {
  timestamp_us: number;
  energy: number;
  source?: string;
}

export interface RefineResult {
  success: boolean;
  summary: string;
  tags: string[];
  interest_points: Array<{ frame_us: number; label: string; confidence: number }>;
  peak_moment?: PeakMoment;
  recommended_in_out?: RecommendedInOut;
  visual_energy_curve: VisualEnergyCurvePoint[];
  quality_flags: string[];
  confidence: { summary: number; tags: number; quality_flags: number };
  peak_confidence_vlm: number;
  needs_precision: boolean;
  error?: string;
  prompt_hash: string;
}

// ── Pass 3: Precision Output ───────────────────────────────────────

export interface PrecisionResult {
  success: boolean;
  peak_moment?: PeakMoment;
  recommended_in_out?: RecommendedInOut;
  error?: string;
  prompt_hash: string;
}

// ── Aggregate Peak Analysis (for segments.json) ────────────────────

export interface CoarseLocator {
  contact_sheet_id: string;
  tile_start_index: number;
  tile_end_index: number;
  coarse_window_start_us: number;
  coarse_window_end_us: number;
}

export interface SupportSignals {
  motion_support_score: number;
  audio_support_score: number;
  fused_peak_score: number;
}

export interface PeakAnalysisProvenance {
  coarse_prompt_template_id: string;
  refine_prompt_template_id: string;
  precision_mode: string;
  fusion_version: string;
  support_signal_version: string;
}

export interface PeakAnalysis {
  coarse_locator?: CoarseLocator;
  peak_moments: PeakMoment[];
  recommended_in_out?: RecommendedInOut;
  visual_energy_curve: VisualEnergyCurvePoint[];
  support_signals?: SupportSignals;
  provenance: PeakAnalysisProvenance;
}

// ── Prompt Hash Helpers ────────────────────────────────────────────

export function computeCoarsePromptHash(): string {
  const normalized = COARSE_PROMPT_TEMPLATE.trim().replace(/\s+/g, " ");
  return createHash("sha256")
    .update(normalized + "|" + COARSE_PROMPT_TEMPLATE_ID)
    .digest("hex")
    .slice(0, 16);
}

export function computeRefinePromptHash(): string {
  const normalized = REFINE_PROMPT_TEMPLATE.trim().replace(/\s+/g, " ");
  return createHash("sha256")
    .update(normalized + "|" + REFINE_PROMPT_TEMPLATE_ID)
    .digest("hex")
    .slice(0, 16);
}

export function computePrecisionPromptHash(): string {
  const normalized = PRECISION_PROMPT_TEMPLATE.trim().replace(/\s+/g, " ");
  return createHash("sha256")
    .update(normalized + "|" + PRECISION_PROMPT_TEMPLATE_ID)
    .digest("hex")
    .slice(0, 16);
}

// ── Prompt Templates ───────────────────────────────────────────────

const COARSE_PROMPT_TEMPLATE = `You are analyzing an asset overview contact sheet for editorial peak discovery.

Inputs:
- asset_id: {asset_id}
- contact_sheet_id: {contact_sheet_id}
- tile_map: {tile_map_json}
- transcript_context: {transcript_context}

Tasks:
1. Identify up to 3 tile spans that likely contain the strongest editorial payoff.
2. Return tile indices only. Do not return exact timestamps.
3. Label each span with the most likely peak type and confidence.
4. If evidence is weak, return an empty array instead of guessing.

Peak type vocabulary:
- action_peak: motion apex, impact, takeoff, landing, balance recovery, reveal-through-action
- emotional_peak: strongest facial or bodily reaction, laugh, tears, surprise, relief, awe
- visual_peak: strongest reveal, composition payoff, lighting change, entrance, parallax payoff

Rules:
- Tile indices must exist in the provided tile_map.
- Do not invent speech that is not supported by the transcript context.
- Prefer narrowing over false precision.
- Respond with valid JSON only.

Return this JSON shape:
{
  "coarse_candidates": [
    {
      "tile_start_index": 0,
      "tile_end_index": 0,
      "likely_peak_type": "action_peak | emotional_peak | visual_peak",
      "confidence": 0.0,
      "rationale": "string"
    }
  ]
}`;

const REFINE_PROMPT_TEMPLATE = `You are analyzing a single segment filmstrip for editorial peak refinement.

Segment metadata:
- segment_id: {segment_id}
- segment_type: {segment_type}
- source_range_us: {src_in_us}..{src_out_us}
- filmstrip_tile_map: {tile_map_json}
- coarse_hint: {coarse_hint}
- transcript_excerpt: {transcript_excerpt}

Tasks:
1. Identify the single strongest editorial peak inside this segment.
2. Return the exact best timestamp_us if the filmstrip provides enough evidence.
3. Recommend best_in_us and best_out_us around that peak.
4. Keep summary / tags / interest_points / quality_flags repository-compatible.
5. If the best tile is clear but exact center is still uncertain, set needs_precision=true.

Respond with valid JSON only:
{
  "summary": "string",
  "tags": ["string"],
  "interest_points": [
    { "frame_us": 0, "label": "string", "confidence": 0.0 }
  ],
  "peak_moment": {
    "timestamp_us": 0,
    "type": "action_peak | emotional_peak | visual_peak",
    "confidence": 0.0,
    "description": "string"
  },
  "recommended_in_out": {
    "best_in_us": 0,
    "best_out_us": 0,
    "rationale": "string",
    "needs_precision": false
  },
  "visual_energy_curve": [
    { "timestamp_us": 0, "energy": 0.0 }
  ],
  "quality_flags": ["string"],
  "confidence": {
    "summary": 0.0,
    "tags": 0.0,
    "quality_flags": 0.0
  },
  "peak_confidence": {
    "vlm": 0.0
  }
}`;

const PRECISION_PROMPT_TEMPLATE = `Refine the single strongest editorial peak inside this narrowed high-density window.

Window metadata:
- candidate_window_us: {window_start_us}..{window_end_us}
- refine_peak_timestamp_us: {refine_peak_timestamp_us}
- segment_type: {segment_type}

Tasks:
1. Return the exact best peak timestamp_us inside this window.
2. Tighten best_in_us and best_out_us around that peak.
3. If the refine peak was slightly off, move it and explain why in rationale.

Respond with valid JSON only:
{
  "peak_moment": {
    "timestamp_us": 0,
    "type": "action_peak | emotional_peak | visual_peak",
    "confidence": 0.0,
    "description": "string"
  },
  "recommended_in_out": {
    "best_in_us": 0,
    "best_out_us": 0,
    "rationale": "string"
  }
}`;

// ── Variant Guidance ───────────────────────────────────────────────

const DIALOGUE_GUIDANCE = `Additional guidance for dialogue/interview segments:
- Prioritize the decisive answer landing, emotional face change, laugh, pause after a strong line, or listener reaction.
- Avoid choosing a neutral talking-head midpoint unless it is the real payoff.
- Recommended in/out should avoid cutting mid-phoneme when possible.
- Preserve a short pre-roll before the line lands and a slightly longer post-roll for the reaction.`;

const ACTION_GUIDANCE = `Additional guidance for action segments:
- Prioritize the exact apex: takeoff, impact, catch, balance recovery, collision, jump peak, sudden directional change.
- The peak is usually not the first frame of motion and not the final freeze frame.
- Recommended in/out should preserve anticipation before the peak and a short follow-through after it.
- If multiple micro-peaks exist, choose the strongest editorial payoff and keep others as secondary peaks.`;

const SCENIC_GUIDANCE = `Additional guidance for scenic or visual-payoff segments:
- Prioritize the reveal moment, composition lock-in, subject entrance, lighting transition, or camera move payoff.
- Do not choose a flat establishing frame unless the reveal itself has completed there.
- Recommended in/out should give enough lead-in to perceive the reveal and enough hold to register it.`;

function getVariantGuidance(segmentType: string): string {
  switch (segmentType) {
    case "dialogue":
      return DIALOGUE_GUIDANCE;
    case "action":
    case "music_driven":
      return ACTION_GUIDANCE;
    case "static":
    case "general":
      return SCENIC_GUIDANCE;
    default:
      return "";
  }
}

// ── Prompt Builders ────────────────────────────────────────────────

export function buildCoarsePrompt(input: CoarseInput): string {
  return COARSE_PROMPT_TEMPLATE
    .replace("{asset_id}", input.asset_id)
    .replace("{contact_sheet_id}", input.contact_sheet_id)
    .replace("{tile_map_json}", JSON.stringify(input.tile_map))
    .replace("{transcript_context}", input.transcript_context || "none");
}

export function buildRefinePrompt(input: RefineInput): string {
  const base = REFINE_PROMPT_TEMPLATE
    .replace("{segment_id}", input.segment_id)
    .replace("{segment_type}", input.segment_type)
    .replace("{src_in_us}", String(input.src_in_us))
    .replace("{src_out_us}", String(input.src_out_us))
    .replace("{tile_map_json}", JSON.stringify(input.tile_map))
    .replace("{coarse_hint}", input.coarse_hint ? JSON.stringify(input.coarse_hint) : "none")
    .replace("{transcript_excerpt}", input.transcript_excerpt || "none");

  const guidance = getVariantGuidance(input.segment_type);
  return guidance ? `${base}\n\n${guidance}` : base;
}

export function buildPrecisionPrompt(input: PrecisionInput): string {
  const base = PRECISION_PROMPT_TEMPLATE
    .replace("{window_start_us}", String(input.window_start_us))
    .replace("{window_end_us}", String(input.window_end_us))
    .replace("{refine_peak_timestamp_us}", String(input.refine_peak_timestamp_us))
    .replace("{segment_type}", input.segment_type);

  const guidance = getVariantGuidance(input.segment_type);
  return guidance ? `${base}\n\n${guidance}` : base;
}

// ── JSON Parse Helpers ─────────────────────────────────────────────

function parseJsonResponse(raw: string): unknown {
  let cleaned = raw.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
  }
  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    throw new Error("No JSON object found in VLM response");
  }
  cleaned = cleaned.slice(firstBrace, lastBrace + 1);
  return JSON.parse(cleaned);
}

// ── Normalization Helpers ──────────────────────────────────────────

const PEAK_TYPES = new Set<string>(["action_peak", "emotional_peak", "visual_peak"]);

function normalizePeakType(raw: unknown): PeakType | undefined {
  if (typeof raw !== "string") return undefined;
  return PEAK_TYPES.has(raw) ? (raw as PeakType) : undefined;
}

function clamp01(v: unknown): number {
  if (typeof v !== "number" || !isFinite(v)) return 0.5;
  return Math.max(0, Math.min(1, v));
}

function clampInt(v: unknown, min: number, max: number): number | undefined {
  if (typeof v !== "number" || !isFinite(v)) return undefined;
  const rounded = Math.round(v);
  if (rounded < min || rounded > max) return undefined;
  return rounded;
}

// ── Pass 1: Coarse ─────────────────────────────────────────────────

export function normalizeCoarseResponse(
  raw: unknown,
  tileMap: TileMapEntry[],
  maxCandidates: number,
): CoarseCandidate[] {
  if (!raw || typeof raw !== "object") return [];
  const obj = raw as Record<string, unknown>;
  const candidates = Array.isArray(obj.coarse_candidates) ? obj.coarse_candidates : [];

  const maxTileIndex = tileMap.length > 0 ? Math.max(...tileMap.map((t) => t.tile_index)) : -1;
  const result: CoarseCandidate[] = [];

  for (const c of candidates) {
    if (!c || typeof c !== "object") continue;
    const item = c as Record<string, unknown>;

    const startIdx = clampInt(item.tile_start_index, 0, maxTileIndex);
    const endIdx = clampInt(item.tile_end_index, 0, maxTileIndex);
    if (startIdx === undefined || endIdx === undefined) continue;
    if (startIdx > endIdx) continue;

    const peakType = normalizePeakType(item.likely_peak_type);
    if (!peakType) continue;

    result.push({
      tile_start_index: startIdx,
      tile_end_index: endIdx,
      likely_peak_type: peakType,
      confidence: clamp01(item.confidence),
      rationale: typeof item.rationale === "string" ? item.rationale.slice(0, 500) : "",
    });

    if (result.length >= maxCandidates) break;
  }

  return result;
}

export async function runCoarsePass(
  vlmFn: VlmFn,
  input: CoarseInput,
  policy: PeakDetectionPolicy,
): Promise<CoarseResult> {
  const promptHash = computeCoarsePromptHash();
  const prompt = buildCoarsePrompt(input);

  try {
    const result = await vlmFn(
      [input.image_path],
      prompt,
      { model: policy.model_alias, maxOutputTokens: policy.max_output_tokens },
    );

    const parsed = parseJsonResponse(result.rawJson);
    const candidates = normalizeCoarseResponse(parsed, input.tile_map, policy.coarse_max_candidates);

    return { success: true, candidates, prompt_hash: promptHash };
  } catch (err) {
    return {
      success: false,
      candidates: [],
      error: err instanceof Error ? err.message : String(err),
      prompt_hash: promptHash,
    };
  }
}

// ── Coarse -> Segment Mapping ──────────────────────────────────────

export interface SegmentOverlap {
  segment_id: string;
  src_in_us: number;
  src_out_us: number;
  coarse_candidate: CoarseCandidate;
}

/**
 * Map coarse tile candidates to overlapping segments.
 * Deterministic: tile_index → rep_frame_us → min/max → overlapping segments.
 */
export function mapCoarseToSegments(
  candidates: CoarseCandidate[],
  tileMap: TileMapEntry[],
  segments: Array<{ segment_id: string; src_in_us: number; src_out_us: number }>,
): SegmentOverlap[] {
  const tileByIndex = new Map<number, TileMapEntry>();
  for (const t of tileMap) {
    tileByIndex.set(t.tile_index, t);
  }

  const result: SegmentOverlap[] = [];

  for (const candidate of candidates) {
    // Compute coarse window from tile timestamps
    let windowStartUs = Infinity;
    let windowEndUs = -Infinity;

    for (let i = candidate.tile_start_index; i <= candidate.tile_end_index; i++) {
      const tile = tileByIndex.get(i);
      if (!tile) continue;
      windowStartUs = Math.min(windowStartUs, tile.rep_frame_us);
      windowEndUs = Math.max(windowEndUs, tile.rep_frame_us);
    }

    if (!isFinite(windowStartUs) || !isFinite(windowEndUs)) continue;

    // Find overlapping segments
    for (const seg of segments) {
      if (seg.src_out_us <= windowStartUs || seg.src_in_us >= windowEndUs) continue;
      result.push({
        segment_id: seg.segment_id,
        src_in_us: seg.src_in_us,
        src_out_us: seg.src_out_us,
        coarse_candidate: candidate,
      });
    }
  }

  return result;
}

// ── Filmstrip Tile Map Generation ──────────────────────────────────

/**
 * Generate filmstrip tile_map for a segment using deterministic 6-tile sampling.
 */
export function generateFilmstripTileMap(
  srcInUs: number,
  srcOutUs: number,
  tileCount: number = 6,
): FilmstripTileEntry[] {
  const duration = srcOutUs - srcInUs;
  if (duration <= 0 || tileCount <= 0) return [];

  const step = duration / tileCount;
  const tiles: FilmstripTileEntry[] = [];

  for (let i = 0; i < tileCount; i++) {
    tiles.push({
      tile_index: i,
      frame_us: Math.floor(srcInUs + step * i + step / 2),
    });
  }

  return tiles;
}

// ── Pass 2: Refine ─────────────────────────────────────────────────

export function normalizeRefineResponse(
  raw: unknown,
  srcInUs: number,
  srcOutUs: number,
  segmentId: string,
  maxEnergyCurvePoints: number,
): Omit<RefineResult, "success" | "error" | "prompt_hash"> {
  if (!raw || typeof raw !== "object") {
    return emptyRefineFields();
  }
  const obj = raw as Record<string, unknown>;

  // summary, tags
  const summary = typeof obj.summary === "string" ? obj.summary.trim().slice(0, 500) : "";
  const tags = Array.isArray(obj.tags)
    ? obj.tags.filter((t): t is string => typeof t === "string").map((t) => t.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "")).filter((t) => t.length > 0).slice(0, 20)
    : [];

  // interest_points
  const rawIp = Array.isArray(obj.interest_points) ? obj.interest_points : [];
  const interestPoints: Array<{ frame_us: number; label: string; confidence: number }> = [];
  for (const ip of rawIp) {
    if (!ip || typeof ip !== "object") continue;
    const ipObj = ip as Record<string, unknown>;
    if (typeof ipObj.frame_us !== "number" || typeof ipObj.label !== "string") continue;
    const frameUs = Math.round(ipObj.frame_us);
    if (frameUs < srcInUs || frameUs > srcOutUs) continue;
    const label = ipObj.label.trim();
    if (!label) continue;
    interestPoints.push({
      frame_us: frameUs,
      label,
      confidence: clamp01(ipObj.confidence),
    });
  }

  // peak_moment
  let peakMoment: PeakMoment | undefined;
  const rawPeak = obj.peak_moment as Record<string, unknown> | undefined;
  if (rawPeak && typeof rawPeak === "object") {
    const peakType = normalizePeakType(rawPeak.type);
    const ts = typeof rawPeak.timestamp_us === "number" ? Math.round(rawPeak.timestamp_us) : undefined;
    if (peakType && ts !== undefined && ts >= srcInUs && ts <= srcOutUs) {
      peakMoment = {
        peak_ref: `${segmentId}@${ts}`,
        timestamp_us: ts,
        type: peakType,
        confidence: clamp01(rawPeak.confidence),
        description: typeof rawPeak.description === "string" ? rawPeak.description.slice(0, 500) : "",
        source_pass: "refine_filmstrip",
      };
    }
  }

  // recommended_in_out
  let recommendedInOut: RecommendedInOut | undefined;
  const rawRec = obj.recommended_in_out as Record<string, unknown> | undefined;
  if (rawRec && typeof rawRec === "object") {
    let bestIn = typeof rawRec.best_in_us === "number" ? Math.round(rawRec.best_in_us) : undefined;
    let bestOut = typeof rawRec.best_out_us === "number" ? Math.round(rawRec.best_out_us) : undefined;
    if (bestIn !== undefined && bestOut !== undefined) {
      // Clamp to segment range
      bestIn = Math.max(bestIn, srcInUs);
      bestOut = Math.min(bestOut, srcOutUs);
      if (bestOut > bestIn) {
        recommendedInOut = {
          best_in_us: bestIn,
          best_out_us: bestOut,
          rationale: typeof rawRec.rationale === "string" ? rawRec.rationale.slice(0, 500) : "",
          source_pass: "refine_filmstrip",
        };
      }
    }
  }

  // needs_precision
  const needsPrecision = !!(rawRec && typeof rawRec === "object" && (rawRec as Record<string, unknown>).needs_precision === true);

  // visual_energy_curve
  const rawCurve = Array.isArray(obj.visual_energy_curve) ? obj.visual_energy_curve : [];
  const energyCurve: VisualEnergyCurvePoint[] = [];
  for (const pt of rawCurve) {
    if (!pt || typeof pt !== "object") continue;
    const ptObj = pt as Record<string, unknown>;
    if (typeof ptObj.timestamp_us !== "number" || typeof ptObj.energy !== "number") continue;
    energyCurve.push({
      timestamp_us: Math.round(ptObj.timestamp_us),
      energy: clamp01(ptObj.energy),
      source: typeof ptObj.source === "string" ? ptObj.source : undefined,
    });
    if (energyCurve.length >= maxEnergyCurvePoints) break;
  }

  // quality_flags
  const qualityFlags = Array.isArray(obj.quality_flags)
    ? obj.quality_flags.filter((f): f is string => typeof f === "string").slice(0, 10)
    : [];

  // confidence
  const rawConf = obj.confidence as Record<string, unknown> | undefined;
  const confidence = {
    summary: clamp01(rawConf?.summary),
    tags: clamp01(rawConf?.tags),
    quality_flags: clamp01(rawConf?.quality_flags),
  };

  // peak_confidence.vlm
  const rawPeakConf = obj.peak_confidence as Record<string, unknown> | undefined;
  const peakConfidenceVlm = clamp01(rawPeakConf?.vlm);

  return {
    summary,
    tags,
    interest_points: interestPoints,
    peak_moment: peakMoment,
    recommended_in_out: recommendedInOut,
    visual_energy_curve: energyCurve,
    quality_flags: qualityFlags,
    confidence,
    peak_confidence_vlm: peakConfidenceVlm,
    needs_precision: needsPrecision,
  };
}

function emptyRefineFields(): Omit<RefineResult, "success" | "error" | "prompt_hash"> {
  return {
    summary: "",
    tags: [],
    interest_points: [],
    peak_moment: undefined,
    recommended_in_out: undefined,
    visual_energy_curve: [],
    quality_flags: [],
    confidence: { summary: 0.5, tags: 0.5, quality_flags: 0.5 },
    peak_confidence_vlm: 0,
    needs_precision: false,
  };
}

export async function runRefinePass(
  vlmFn: VlmFn,
  input: RefineInput,
  policy: PeakDetectionPolicy,
): Promise<RefineResult> {
  const promptHash = computeRefinePromptHash();
  const prompt = buildRefinePrompt(input);

  try {
    const result = await vlmFn(
      [input.filmstrip_path],
      prompt,
      { model: policy.model_alias, maxOutputTokens: policy.max_output_tokens },
    );

    const parsed = parseJsonResponse(result.rawJson);
    const normalized = normalizeRefineResponse(
      parsed,
      input.src_in_us,
      input.src_out_us,
      input.segment_id,
      policy.max_energy_curve_points,
    );

    return { success: true, ...normalized, prompt_hash: promptHash };
  } catch (err) {
    return {
      success: false,
      ...emptyRefineFields(),
      error: err instanceof Error ? err.message : String(err),
      prompt_hash: promptHash,
    };
  }
}

// ── Pass 3: Precision ──────────────────────────────────────────────

export function normalizePrecisionResponse(
  raw: unknown,
  windowStartUs: number,
  windowEndUs: number,
  segmentId: string,
): Omit<PrecisionResult, "success" | "error" | "prompt_hash"> {
  if (!raw || typeof raw !== "object") {
    return { peak_moment: undefined, recommended_in_out: undefined };
  }
  const obj = raw as Record<string, unknown>;

  let peakMoment: PeakMoment | undefined;
  const rawPeak = obj.peak_moment as Record<string, unknown> | undefined;
  if (rawPeak && typeof rawPeak === "object") {
    const peakType = normalizePeakType(rawPeak.type);
    const ts = typeof rawPeak.timestamp_us === "number" ? Math.round(rawPeak.timestamp_us) : undefined;
    if (peakType && ts !== undefined && ts >= windowStartUs && ts <= windowEndUs) {
      peakMoment = {
        peak_ref: `${segmentId}@${ts}`,
        timestamp_us: ts,
        type: peakType,
        confidence: clamp01(rawPeak.confidence),
        description: typeof rawPeak.description === "string" ? rawPeak.description.slice(0, 500) : "",
        source_pass: "precision_dense_frames",
      };
    }
  }

  let recommendedInOut: RecommendedInOut | undefined;
  const rawRec = obj.recommended_in_out as Record<string, unknown> | undefined;
  if (rawRec && typeof rawRec === "object") {
    let bestIn = typeof rawRec.best_in_us === "number" ? Math.round(rawRec.best_in_us) : undefined;
    let bestOut = typeof rawRec.best_out_us === "number" ? Math.round(rawRec.best_out_us) : undefined;
    if (bestIn !== undefined && bestOut !== undefined) {
      bestIn = Math.max(bestIn, windowStartUs);
      bestOut = Math.min(bestOut, windowEndUs);
      if (bestOut > bestIn) {
        recommendedInOut = {
          best_in_us: bestIn,
          best_out_us: bestOut,
          rationale: typeof rawRec.rationale === "string" ? rawRec.rationale.slice(0, 500) : "",
          source_pass: "precision_dense_frames",
        };
      }
    }
  }

  return { peak_moment: peakMoment, recommended_in_out: recommendedInOut };
}

export async function runPrecisionPass(
  vlmFn: VlmFn,
  input: PrecisionInput,
  policy: PeakDetectionPolicy,
): Promise<PrecisionResult> {
  const promptHash = computePrecisionPromptHash();
  const prompt = buildPrecisionPrompt(input);

  try {
    const result = await vlmFn(
      input.frame_paths,
      prompt,
      { model: policy.model_alias, maxOutputTokens: policy.max_output_tokens },
    );

    const parsed = parseJsonResponse(result.rawJson);
    const normalized = normalizePrecisionResponse(
      parsed,
      input.window_start_us,
      input.window_end_us,
      input.segment_id,
    );

    return { success: true, ...normalized, prompt_hash: promptHash };
  } catch (err) {
    return {
      success: false,
      peak_moment: undefined,
      recommended_in_out: undefined,
      error: err instanceof Error ? err.message : String(err),
      prompt_hash: promptHash,
    };
  }
}

// ── Precision Eligibility ──────────────────────────────────────────

/**
 * Determine if a segment should proceed to precision pass.
 */
export function shouldRunPrecision(
  segmentType: string,
  needsPrecision: boolean,
  peakConfidenceVlm: number,
  policy: PeakDetectionPolicy,
): boolean {
  if (policy.peak_precision_mode === "never") return false;
  if (policy.peak_precision_mode === "always") return needsPrecision;
  // "action_only": run precision only for action/music_driven when needed
  if (segmentType === "action" || segmentType === "music_driven") {
    return needsPrecision;
  }
  return false;
}

// ── Confidence Fusion ──────────────────────────────────────────────

/**
 * Fuse VLM peak confidence with motion and audio support signals.
 * Per design doc §9.2.
 */
export function fusePeakConfidence(
  vlmPeakConfidence: number,
  motionSupportScore: number,
  audioSupportScore?: number,
  peakType?: PeakType,
): number {
  let vlmWeight: number;
  let motionWeight: number;
  let audioWeight: number;

  if (audioSupportScore !== undefined) {
    // With audio support
    vlmWeight = 0.70;
    motionWeight = 0.20;
    audioWeight = 0.10;

    // Type-specific adjustments
    if (peakType === "action_peak") {
      vlmWeight = 0.60;
      motionWeight = 0.30;
      audioWeight = 0.10;
    } else if (peakType === "emotional_peak") {
      vlmWeight = 0.65;
      motionWeight = 0.15;
      audioWeight = 0.20;
    }

    const fused = vlmWeight * vlmPeakConfidence +
      motionWeight * motionSupportScore +
      audioWeight * audioSupportScore;
    return Math.max(0, Math.min(1, fused));
  } else {
    // Without audio support
    vlmWeight = 0.75;
    motionWeight = 0.25;

    if (peakType === "action_peak") {
      vlmWeight = 0.65;
      motionWeight = 0.35;
    } else if (peakType === "visual_peak") {
      vlmWeight = 0.80;
      motionWeight = 0.20;
    }

    const fused = vlmWeight * vlmPeakConfidence + motionWeight * motionSupportScore;
    return Math.max(0, Math.min(1, fused));
  }
}

// ── Peak -> Interest Point Mirror ──────────────────────────────────

/**
 * Mirror peak_moments into interest_points format.
 * Label format: "type: description"
 */
export function mirrorPeakToInterestPoints(
  peakMoments: PeakMoment[],
): Array<{ frame_us: number; label: string; confidence: number }> {
  return peakMoments.map((p) => ({
    frame_us: p.timestamp_us,
    label: `${p.type}: ${p.description}`,
    confidence: p.confidence,
  }));
}

// ── Peak Analysis Assembly ─────────────────────────────────────────

/**
 * Build the complete PeakAnalysis from progressive resolution results.
 */
export function buildPeakAnalysis(opts: {
  coarseLocator?: CoarseLocator;
  refinePeakMoment?: PeakMoment;
  precisionPeakMoment?: PeakMoment;
  refineRecommendedInOut?: RecommendedInOut;
  precisionRecommendedInOut?: RecommendedInOut;
  visualEnergyCurve: VisualEnergyCurvePoint[];
  supportSignals?: SupportSignals;
  precisionMode: string;
}): PeakAnalysis {
  // Precision overrides refine when available
  const peakMoment = opts.precisionPeakMoment ?? opts.refinePeakMoment;
  const recommendedInOut = opts.precisionRecommendedInOut ?? opts.refineRecommendedInOut;

  return {
    coarse_locator: opts.coarseLocator,
    peak_moments: peakMoment ? [peakMoment] : [],
    recommended_in_out: recommendedInOut,
    visual_energy_curve: opts.visualEnergyCurve,
    support_signals: opts.supportSignals,
    provenance: {
      coarse_prompt_template_id: COARSE_PROMPT_TEMPLATE_ID,
      refine_prompt_template_id: REFINE_PROMPT_TEMPLATE_ID,
      precision_mode: opts.precisionMode,
      fusion_version: FUSION_VERSION,
      support_signal_version: SUPPORT_SIGNAL_VERSION,
    },
  };
}
