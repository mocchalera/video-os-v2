import * as fs from "node:fs";
import * as path from "node:path";
import { readAuthoritativeAssetMediaCapabilities } from "./source-media-capabilities.js";

export interface PeakMaterializationCandidate {
  segment_id: string;
  asset_id: string;
  src_in_us: number;
  src_out_us: number;
  confidence: number;
  peak_signals?: {
    motion?: number;
    audio_rms?: number;
    speech_keyword?: string[];
  };
  editorial_signals?: {
    peak_strength_score?: number;
    peak_type?: "action_peak" | "emotional_peak" | "visual_peak";
    peak_ref?: string;
    peak_source_pass?: string;
  };
  trim_hint?: {
    source_center_us?: number;
    preferred_duration_us?: number;
    min_duration_us?: number;
    max_duration_us?: number;
    window_start_us?: number;
    window_end_us?: number;
    interest_point_label?: string;
    interest_point_confidence?: number;
    peak_ref?: string;
    peak_type?: "action_peak" | "emotional_peak" | "visual_peak";
    center_source?: "refine_filmstrip" | "precision_dense_frames" | "precision_proxy_clip" | "interest_point_fallback" | "midpoint_fallback";
    rationale?: string;
    recommended_in_us?: number;
    recommended_out_us?: number;
  };
}

export interface PeakMaterializationSelects {
  candidates: PeakMaterializationCandidate[];
}

interface SegmentsDoc {
  items?: SegmentWithPeak[];
}

interface SegmentWithPeak {
  segment_id?: string;
  src_in_us?: number;
  src_out_us?: number;
  peak_analysis?: {
    support_signals?: {
      motion_support_score?: number;
      audio_support_score?: number;
      fused_peak_score?: number;
    };
    recommended_in_out?: {
      best_in_us?: number;
      best_out_us?: number;
      rationale?: string;
      source_pass?: string;
    };
    peak_moments?: Array<{
      peak_ref?: string;
      timestamp_us?: number;
      type?: string;
      confidence?: number;
      description?: string;
      source_pass?: string;
    }>;
  };
}

export function materializePeakSignalsFromSegments(
  projectDir: string,
  selects: PeakMaterializationSelects,
): boolean {
  if (!Array.isArray(selects?.candidates)) return false;

  const segmentsPath = path.join(projectDir, "03_analysis", "segments.json");
  if (!fs.existsSync(segmentsPath)) return false;

  let segments: SegmentsDoc;
  try {
    segments = JSON.parse(fs.readFileSync(segmentsPath, "utf-8")) as SegmentsDoc;
  } catch {
    return false;
  }

  const byId = new Map((segments.items ?? []).map((segment) => [segment.segment_id, segment]));
  const capabilities = readAuthoritativeAssetMediaCapabilities(projectDir);
  let changed = false;

  for (const candidate of selects.candidates) {
    const capability = capabilities.get(candidate.asset_id);
    if (capability && capability.media_kind !== "image" && (
      capability.media_kind === "audio" || capability.source_capabilities.has_video === false
    )) {
      changed = clearVisualPeakMaterialization(candidate) || changed;
      continue;
    }
    const segment = byId.get(candidate.segment_id);
    const support = segment?.peak_analysis?.support_signals;
    const moment = segment?.peak_analysis?.peak_moments?.[0];
    const recommended = segment?.peak_analysis?.recommended_in_out;
    if (!support && !moment && !recommended) continue;

    const momentInCandidate = momentOverlapsCandidate(candidate, moment);
    const recommendedOverlapsCandidate = recommendedRangeOverlapsCandidate(candidate, recommended);
    const hasTemporalPeakEvidence = hasMomentTimestamp(moment) || hasRecommendedRange(recommended);
    if (hasTemporalPeakEvidence && !momentInCandidate && !recommendedOverlapsCandidate) {
      continue;
    }

    candidate.peak_signals ??= {};
    if (support?.motion_support_score != null && candidate.peak_signals.motion == null) {
      candidate.peak_signals.motion = clamp01(support.motion_support_score);
      changed = true;
    }
    if (support?.audio_support_score != null && candidate.peak_signals.audio_rms == null) {
      candidate.peak_signals.audio_rms = clamp01(support.audio_support_score);
      changed = true;
    }

    candidate.editorial_signals ??= {};
    if (support?.fused_peak_score != null && candidate.editorial_signals.peak_strength_score == null) {
      candidate.editorial_signals.peak_strength_score = clamp01(support.fused_peak_score);
      changed = true;
    }
    const peakType = momentInCandidate ? normalizePeakType(moment?.type) : undefined;
    if (peakType && candidate.editorial_signals.peak_type == null) {
      candidate.editorial_signals.peak_type = peakType;
      changed = true;
    }
    if (momentInCandidate && moment?.peak_ref && candidate.editorial_signals.peak_ref == null) {
      candidate.editorial_signals.peak_ref = moment.peak_ref;
      changed = true;
    }
    if (momentInCandidate && moment?.source_pass && candidate.editorial_signals.peak_source_pass == null) {
      candidate.editorial_signals.peak_source_pass = moment.source_pass;
      changed = true;
    }

    if (materializeTrimHint(
      candidate,
      segment,
      momentInCandidate ? moment : undefined,
      recommendedOverlapsCandidate ? recommended : undefined,
      peakType,
    )) {
      changed = true;
    }
  }

  return changed;
}

function clearVisualPeakMaterialization(candidate: PeakMaterializationCandidate): boolean {
  let changed = false;
  if (candidate.peak_signals !== undefined) {
    delete candidate.peak_signals;
    changed = true;
  }

  if (candidate.editorial_signals) {
    const next = { ...candidate.editorial_signals } as Record<string, unknown>;
    for (const key of ["peak_strength_score", "peak_type", "peak_ref", "peak_source_pass"]) {
      if (!(key in next)) continue;
      delete next[key];
      changed = true;
    }
    if (Object.keys(next).length === 0) {
      delete candidate.editorial_signals;
      changed = true;
    } else if (changed) {
      candidate.editorial_signals = next as PeakMaterializationCandidate["editorial_signals"];
    }
  }

  if (candidate.trim_hint) {
    const next = { ...candidate.trim_hint } as Record<string, unknown>;
    for (const key of [
      "source_center_us",
      "interest_point_label",
      "interest_point_confidence",
      "peak_ref",
      "peak_type",
      "center_source",
      "recommended_in_us",
      "recommended_out_us",
      "window_start_us",
      "window_end_us",
    ]) {
      if (!(key in next)) continue;
      delete next[key];
      changed = true;
    }
    if (Object.keys(next).length === 0) {
      delete candidate.trim_hint;
      changed = true;
    } else if (changed) {
      candidate.trim_hint = next as PeakMaterializationCandidate["trim_hint"];
    }
  }

  return changed;
}

function materializeTrimHint(
  candidate: PeakMaterializationCandidate,
  segment: SegmentWithPeak | undefined,
  moment: SegmentWithPeak["peak_analysis"] extends infer T
    ? T extends { peak_moments?: Array<infer M> } ? M | undefined : never
    : never,
  recommended: SegmentWithPeak["peak_analysis"] extends infer T
    ? T extends { recommended_in_out?: infer R } ? R | undefined : never
    : never,
  peakType: "action_peak" | "emotional_peak" | "visual_peak" | undefined,
): boolean {
  const center = hasMomentTimestamp(moment)
    ? clampInteger(moment.timestamp_us, candidate.src_in_us, candidate.src_out_us)
    : undefined;
  const recommendedIn = hasRecommendedRange(recommended)
    ? clampInteger(recommended.best_in_us, candidate.src_in_us, candidate.src_out_us)
    : undefined;
  const recommendedOut = hasRecommendedRange(recommended)
    ? clampInteger(recommended.best_out_us, candidate.src_in_us, candidate.src_out_us)
    : undefined;
  if (center == null && (recommendedIn == null || recommendedOut == null)) return false;

  const current = candidate.trim_hint ?? {};
  const next = { ...current };
  if (center != null) next.source_center_us ??= center;
  if (recommendedIn != null && recommendedOut != null && recommendedOut > recommendedIn) {
    next.recommended_in_us ??= recommendedIn;
    next.recommended_out_us ??= recommendedOut;
    next.window_start_us ??= recommendedIn;
    next.window_end_us ??= recommendedOut;
    next.preferred_duration_us ??= Math.max(1, recommendedOut - recommendedIn);
  }
  const segmentDuration = Math.max(1, (segment?.src_out_us ?? candidate.src_out_us) - (segment?.src_in_us ?? candidate.src_in_us));
  next.min_duration_us ??= Math.min(next.preferred_duration_us ?? segmentDuration, 1_000_000);
  next.max_duration_us ??= Math.min(segmentDuration, Math.max(next.preferred_duration_us ?? segmentDuration, 6_000_000));
  if (moment?.description) next.interest_point_label ??= moment.description;
  if (typeof moment?.confidence === "number") next.interest_point_confidence ??= clamp01(moment.confidence);
  if (moment?.peak_ref) next.peak_ref ??= moment.peak_ref;
  if (peakType) next.peak_type ??= peakType;
  next.center_source ??= centerSourceForPass(moment?.source_pass ?? recommended?.source_pass);
  next.rationale ??= recommended?.rationale ?? "analysis peak materialized for candidate trim";

  candidate.trim_hint = next;
  return true;
}

function momentOverlapsCandidate(
  candidate: PeakMaterializationCandidate,
  moment: SegmentWithPeak["peak_analysis"] extends infer T
    ? T extends { peak_moments?: Array<infer M> } ? M | undefined : never
    : never,
): boolean {
  return hasMomentTimestamp(moment) &&
    moment.timestamp_us >= candidate.src_in_us &&
    moment.timestamp_us <= candidate.src_out_us;
}

function recommendedRangeOverlapsCandidate(
  candidate: PeakMaterializationCandidate,
  recommended: SegmentWithPeak["peak_analysis"] extends infer T
    ? T extends { recommended_in_out?: infer R } ? R | undefined : never
    : never,
): boolean {
  return hasRecommendedRange(recommended) &&
    recommended.best_in_us < candidate.src_out_us &&
    candidate.src_in_us < recommended.best_out_us;
}

function hasMomentTimestamp(
  moment: SegmentWithPeak["peak_analysis"] extends infer T
    ? T extends { peak_moments?: Array<infer M> } ? M | undefined : never
    : never,
): moment is NonNullable<typeof moment> & { timestamp_us: number } {
  return typeof moment?.timestamp_us === "number" && Number.isFinite(moment.timestamp_us);
}

function hasRecommendedRange(
  recommended: SegmentWithPeak["peak_analysis"] extends infer T
    ? T extends { recommended_in_out?: infer R } ? R | undefined : never
    : never,
): recommended is NonNullable<typeof recommended> & { best_in_us: number; best_out_us: number } {
  return typeof recommended?.best_in_us === "number" &&
    Number.isFinite(recommended.best_in_us) &&
    typeof recommended.best_out_us === "number" &&
    Number.isFinite(recommended.best_out_us) &&
    recommended.best_out_us > recommended.best_in_us;
}

function centerSourceForPass(sourcePass: string | undefined) {
  if (sourcePass?.startsWith("marlin_")) return "precision_proxy_clip" as const;
  if (sourcePass === "precision_dense_frames") return "precision_dense_frames" as const;
  if (sourcePass === "refine_filmstrip") return "refine_filmstrip" as const;
  return "interest_point_fallback" as const;
}

function normalizePeakType(value: string | undefined): "action_peak" | "emotional_peak" | "visual_peak" | undefined {
  if (value === "action_peak" || value === "emotional_peak" || value === "visual_peak") {
    return value;
  }
  return undefined;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.round(Math.max(min, Math.min(value, max)));
}
