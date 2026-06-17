import type { SegmentItem as BaseSegmentItem } from "../connectors/ffmpeg-segmenter.js";
import type { Candidate, SelectsCandidates } from "../artifacts/types.js";

type PeakType = "action_peak" | "emotional_peak" | "visual_peak";

export type SegmentItem = BaseSegmentItem & {
  visual_quality?: {
    scores?: {
      light_quality?: number;
      subject_prominence?: number;
      motion_quality?: number;
      emotional_expression?: number;
      composition_score?: number;
    };
    labels?: {
      lighting_style?: string[];
      composition_tags?: string[];
      expression_tags?: string[];
      motion_tags?: string[];
    };
  };
};

export function enrichSelectsFromAnalysis(
  selects: SelectsCandidates,
  segments: SegmentItem[],
): SelectsCandidates {
  const segmentsById = new Map(segments.map((segment) => [segment.segment_id, segment]));

  return {
    ...selects,
    candidates: selects.candidates.map((candidate) => {
      const segment = segmentsById.get(candidate.segment_id);
      if (!segment) return cloneCandidate(candidate);
      return enrichCandidate(candidate, segment);
    }),
  };
}

function enrichCandidate(candidate: Candidate, segment: SegmentItem): Candidate {
  const next: Candidate = cloneCandidate(candidate);
  const editorial = { ...(next.editorial_signals ?? {}) };
  const peakSignals = { ...(next.peak_signals ?? {}) };

  const firstPeak = segment.peak_analysis?.peak_moments?.[0];
  const peakType = normalizePeakType(firstPeak?.type);
  if (peakType && !hasValue(editorial.peak_type)) editorial.peak_type = peakType;
  if (isScore(firstPeak?.confidence) && !hasValue(editorial.peak_strength_score)) {
    editorial.peak_strength_score = clamp01(firstPeak.confidence);
  }
  if (isNonEmptyString(firstPeak?.peak_ref) && !hasValue(editorial.peak_ref)) {
    editorial.peak_ref = firstPeak.peak_ref;
  }

  const support = segment.peak_analysis?.support_signals;
  if (isScore(support?.motion_support_score) && !hasValue(peakSignals.motion)) {
    peakSignals.motion = clamp01(support.motion_support_score);
  }
  if (isScore(support?.audio_support_score) && !hasValue(peakSignals.audio_rms)) {
    peakSignals.audio_rms = clamp01(support.audio_support_score);
  }

  const scores = segment.visual_quality?.scores;
  if (isScore(scores?.motion_quality) && !hasValue(editorial.motion_energy_score)) {
    editorial.motion_energy_score = clamp01(scores.motion_quality);
  }
  if (
    isScore(scores?.emotional_expression) &&
    scores.emotional_expression > 0.5 &&
    !hasValue(editorial.reaction_intensity_score)
  ) {
    editorial.reaction_intensity_score = clamp01(scores.emotional_expression);
  }

  const visualTags = visualQualityTags(segment);
  if (visualTags.length > 0) {
    editorial.visual_tags = mergeTags(editorial.visual_tags, visualTags);
  }

  if (!hasValue(editorial.semantic_cluster_id)) {
    editorial.semantic_cluster_id = deriveSemanticClusterId(segment);
  }

  if (Object.keys(editorial).length > 0) next.editorial_signals = editorial;
  if (Object.keys(peakSignals).length > 0) next.peak_signals = peakSignals;
  if (!hasValue(next.motif_tags)) {
    const motifTags = deriveMotifTags(segment.tags);
    if (motifTags.length > 0) next.motif_tags = motifTags;
  }
  if (!hasValue(next.story_role) && hasValue(next.eligible_beats)) {
    next.story_role = deriveStoryRole(next.eligible_beats);
  }

  return next;
}

function cloneCandidate(candidate: Candidate): Candidate {
  return {
    ...candidate,
    risks: [...candidate.risks],
    ...(candidate.quality_flags ? { quality_flags: [...candidate.quality_flags] } : {}),
    ...(candidate.evidence ? { evidence: [...candidate.evidence] } : {}),
    ...(candidate.eligible_beats ? { eligible_beats: [...candidate.eligible_beats] } : {}),
    ...(candidate.motif_tags ? { motif_tags: [...candidate.motif_tags] } : {}),
    ...(candidate.utterance_ids ? { utterance_ids: [...candidate.utterance_ids] } : {}),
    ...(candidate.editorial_signals
      ? {
          editorial_signals: {
            ...candidate.editorial_signals,
            ...(candidate.editorial_signals.visual_tags
              ? { visual_tags: [...candidate.editorial_signals.visual_tags] }
              : {}),
          },
        }
      : {}),
    ...(candidate.peak_signals
      ? {
          peak_signals: {
            ...candidate.peak_signals,
            ...(candidate.peak_signals.speech_keyword ? { speech_keyword: [...candidate.peak_signals.speech_keyword] } : {}),
          },
        }
      : {}),
    ...(candidate.trim_hint ? { trim_hint: { ...candidate.trim_hint } } : {}),
  };
}

function visualQualityTags(segment: SegmentItem): string[] {
  const labels = segment.visual_quality?.labels;
  if (!labels) return [];
  return [
    ...(labels.lighting_style ?? []),
    ...(labels.composition_tags ?? []),
    ...(labels.expression_tags ?? []),
    ...(labels.motion_tags ?? []),
  ].map(normalizeTag).filter(isNonEmptyString);
}

function deriveMotifTags(tags: string[] | undefined): string[] {
  return mergeTags([], (tags ?? []).map(normalizeTag).filter(isNonEmptyString)).slice(0, 8);
}

function deriveStoryRole(eligibleBeats: string[] | undefined): NonNullable<Candidate["story_role"]> {
  const beats = (eligibleBeats ?? []).map(normalizeTag).filter(isNonEmptyString);
  const joined = beats.join(" ");
  if (/\b(hook|opening)\b/.test(joined)) return "hook";
  if (/\bsetup\b/.test(joined)) return "setup";
  if (/\b(closing|ending|payoff|release)\b/.test(joined)) return "closing";
  if (/\b(experience|development|immersion|middle)\b/.test(joined)) return "experience";
  return "experience";
}

function deriveSemanticClusterId(segment: SegmentItem): string {
  const tags = (segment.tags ?? []).map(normalizeTag).filter(isNonEmptyString);
  const joined = tags.join(" ");
  if (/\b(aerial|drone|overhead)\b/.test(joined)) return "aerial";

  const location = /\b(indoor|interior|kitchen|workshop|restaurant|room|craft)\b/.test(joined)
    ? "indoor"
    : /\b(outdoor|landscape|mountain|forest|tree|river|snow|field|nature|sky)\b/.test(joined)
      ? "outdoor"
      : normalizeAssetPrefix(segment.asset_id);

  const primary = primaryClusterTag(tags);
  return `${location}_${primary}`;
}

function primaryClusterTag(tags: string[]): string {
  const joined = tags.join(" ");
  if (/\b(craft|artisan|handmade|woodwork|pottery|weaving)\b/.test(joined)) return "craft";
  if (/\b(landscape|mountain|forest|tree|river|snow|field|nature|sky)\b/.test(joined)) return "landscape";
  if (/\b(food|meal|kitchen|cooking|dish)\b/.test(joined)) return "food";
  if (/\b(face|person|people|smile|reaction|portrait)\b/.test(joined)) return "people";
  if (/\b(motion|walking|running|vehicle|action)\b/.test(joined)) return "motion";
  return tags.find((tag) => !GENERIC_TAGS.has(tag)) ?? "general";
}

const GENERIC_TAGS = new Set(["indoor", "outdoor", "scene", "shot", "video", "clip", "general"]);

function normalizeAssetPrefix(assetId: string): string {
  return normalizeTag(assetId.split(/[-_]/)[0] || "asset") || "asset";
}

function mergeTags(existing: string[] | undefined, additions: string[]): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const tag of [...(existing ?? []), ...additions]) {
    const normalized = normalizeTag(tag);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    merged.push(normalized);
  }
  return merged;
}

function normalizeTag(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function normalizePeakType(value: string | undefined): PeakType | undefined {
  if (value === "action_peak" || value === "emotional_peak" || value === "visual_peak") return value;
  return undefined;
}

function hasValue(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function isScore(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
