import type { BgmAnalysis } from "./transition-types.js";
import type {
  LyricMvProfileThresholds,
  LyricMvTimelineMetadata,
} from "./types.js";

export const DEFAULT_LYRIC_MV_THRESHOLDS: LyricMvProfileThresholds = {
  background_hold: { min_sec: 2, target_sec: 4, max_sec: 12, intentional_long_hold_sec: 8 },
  caption_cadence: { min_sec: 2, target_sec: 3, max_sec: 4 },
  music_section_cadence: { min_sec: 8, target_sec: 16, max_sec: 32 },
  motion_cadence: { min_sec: 4, target_sec: 8, max_sec: 12 },
};

/** Project the single bound BGM analysis into canonical lyric_mv timeline metadata. */
export function buildLyricMvTimelineMetadata(
  thresholds: LyricMvProfileThresholds = DEFAULT_LYRIC_MV_THRESHOLDS,
  analysis: BgmAnalysis | undefined,
  fpsNum: number,
  fpsDen = 1,
): LyricMvTimelineMetadata {
  const toFrame = (seconds: number): number => Math.max(0, Math.round(seconds * fpsNum / fpsDen));
  const sections = (analysis?.sections ?? [])
    .filter((section) => Number.isFinite(section.start_sec) && Number.isFinite(section.end_sec) && section.end_sec > section.start_sec)
    .map((section) => ({
      id: section.id,
      label: section.label,
      start_frame: toFrame(section.start_sec),
      end_frame: Math.max(1, toFrame(section.end_sec)),
      ...(section.evidence_classification ? { evidence_classification: section.evidence_classification } : {}),
    }));
  const events = new Map<string, LyricMvTimelineMetadata["music_events"][number]>();
  const sectionFor = (seconds: number): string | undefined => sections.find((section) => {
    const start = section.start_frame * fpsDen / fpsNum;
    const end = section.end_frame * fpsDen / fpsNum;
    return seconds >= start && seconds < end;
  })?.id;
  const add = (
    kind: "onset" | "section_start",
    seconds: number,
    provenance: string,
    evidenceClassification?: "measured" | "synthetic" | "unavailable",
    sectionId?: string,
  ): void => {
    if (!Number.isFinite(seconds) || seconds < 0) return;
    const frame = toFrame(seconds);
    const key = `${kind}:${frame}`;
    if (events.has(key)) return;
    const resolvedSectionId = sectionId ?? sectionFor(seconds);
    events.set(key, {
      kind,
      frame,
      provenance,
      ...(resolvedSectionId ? { section_id: resolvedSectionId } : {}),
      ...(evidenceClassification ? { evidence_classification: evidenceClassification } : {}),
    });
  };
  for (const section of analysis?.sections ?? []) {
    add("section_start", section.start_sec, "bgm_analysis.sections", section.evidence_classification, section.id);
  }
  const onsets = analysis?.onsets ?? [];
  if (onsets.length > 0) {
    for (const onset of onsets) {
      add("onset", onset.time_sec, "bgm_analysis.onsets", onset.evidence_classification);
    }
  } else {
    for (const seconds of analysis?.beats_sec ?? []) {
      add("onset", seconds, "bgm_analysis.beats_sec");
    }
  }
  return {
    version: "lyric-mv/v1",
    profile_id: "lyric_mv",
    thresholds: structuredClone(thresholds),
    music_sections: sections,
    music_events: [...events.values()].sort((a, b) => a.frame - b.frame || a.kind.localeCompare(b.kind)),
  };
}
