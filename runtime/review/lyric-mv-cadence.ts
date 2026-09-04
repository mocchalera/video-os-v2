import type {
  CreativeBrief,
  EditBlueprint,
  LyricMvProfileThresholds,
  LyricMvTimelineMetadata,
  TimelineClip,
  TimelineIR,
} from "../compiler/types.js";
import { DEFAULT_LYRIC_MV_THRESHOLDS } from "../compiler/lyric-mv.js";

export const LYRIC_MV_CADENCE_COMPONENTS = [
  "background_cut",
  "caption_cue",
  "in_frame_motion",
  "music_section",
  "music_onset",
  "transition",
] as const;

export type LyricMvCadenceComponent = (typeof LYRIC_MV_CADENCE_COMPONENTS)[number];

interface ComponentEvent {
  frame: number;
  source: string;
}

interface ActiveInterval {
  start_frame: number;
  end_frame: number;
  source: string;
}

export interface LyricMvComponentBreakdown {
  event_count: number;
  event_frames: number[];
  events: ComponentEvent[];
  active_intervals: ActiveInterval[];
}

export interface LyricMvStaticRegion {
  start_frame: number;
  end_frame: number;
  duration_frames: number;
  changed_by: LyricMvCadenceComponent[];
  fully_static: boolean;
}

export interface LyricMvLongHoldFinding {
  clip_id: string;
  duration_frames: number;
  duration_sec: number;
  threshold_sec: number;
  reason: string | null;
  section_id: string | null;
  status: "intentional" | "missing_reason" | "missing_section_binding" | "missing_reason_and_section_binding";
}

export interface LyricMvCadenceReport {
  version: "lyric-mv-cadence/v1";
  profile_id: "lyric_mv";
  status: "pass" | "warn" | "fail" | "skipped";
  duration_frames: number;
  thresholds: LyricMvProfileThresholds;
  component_breakdown: Record<LyricMvCadenceComponent, LyricMvComponentBreakdown>;
  composite: {
    event_count: number;
    event_frames: number[];
    interval_count: number;
    max_gap_frames: number | null;
    max_gap_sec: number | null;
    min_gap_frames: number | null;
    gaps_over_max: Array<{ start_frame: number; end_frame: number; duration_frames: number }>;
    gaps_over_target: Array<{ start_frame: number; end_frame: number; duration_frames: number }>;
    gaps_under_min: Array<{ start_frame: number; end_frame: number; duration_frames: number }>;
  };
  static_regions: {
    total_count: number;
    fully_static_count: number;
    changed_count: number;
    regions: LyricMvStaticRegion[];
  };
  long_holds: LyricMvLongHoldFinding[];
  degraded_reasons: string[];
}

export function isLyricMvProfile(input: {
  timeline?: TimelineIR;
  blueprint?: EditBlueprint;
  brief?: CreativeBrief;
}): boolean {
  const timelineProfile = recordValue(input.timeline?.metadata?.lyric_mv)?.profile_id;
  return timelineProfile === "lyric_mv" ||
    input.blueprint?.resolved_profile?.id === "lyric_mv" ||
    input.brief?.project?.strategy === "lyric_mv" ||
    input.brief?.editorial?.profile_hint === "lyric_mv";
}

export function lyricMvThresholdsFromTimeline(
  timeline: TimelineIR | undefined,
): LyricMvProfileThresholds {
  const raw = recordValue(timeline?.metadata?.lyric_mv)?.thresholds;
  return isLyricMvThresholds(raw) ? structuredClone(raw) : structuredClone(DEFAULT_LYRIC_MV_THRESHOLDS);
}

export function evaluateLyricMvCadence(
  timeline: TimelineIR | undefined,
  thresholds: LyricMvProfileThresholds = DEFAULT_LYRIC_MV_THRESHOLDS,
): LyricMvCadenceReport {
  const emptyBreakdown = emptyComponentBreakdown();
  if (!timeline) {
    return {
      version: "lyric-mv-cadence/v1",
      profile_id: "lyric_mv",
      status: "skipped",
      duration_frames: 0,
      thresholds: structuredClone(thresholds),
      component_breakdown: emptyBreakdown,
      composite: emptyComposite(),
      static_regions: { total_count: 0, fully_static_count: 0, changed_count: 0, regions: [] },
      long_holds: [],
      degraded_reasons: ["timeline_missing"],
    };
  }

  const clips = getV1Clips(timeline);
  const fps = timeline.sequence.fps_num / timeline.sequence.fps_den;
  const durationFrames = clips.reduce(
    (max, clip) => Math.max(max, clip.timeline_in_frame + clip.timeline_duration_frames),
    0,
  );
  if (clips.length === 0 || durationFrames <= 0) {
    return {
      version: "lyric-mv-cadence/v1",
      profile_id: "lyric_mv",
      status: "skipped",
      duration_frames: 0,
      thresholds: structuredClone(thresholds),
      component_breakdown: emptyBreakdown,
      composite: emptyComposite(),
      static_regions: { total_count: 0, fully_static_count: 0, changed_count: 0, regions: [] },
      long_holds: [],
      degraded_reasons: ["no_v1_video_clips"],
    };
  }

  const events = emptyEventMap();
  const intervals = emptyIntervalMap();
  const backgroundCutFrames = new Set<number>();
  const musicEventFrames = new Map<number, LyricMvCadenceComponent>();

  for (let index = 1; index < clips.length; index += 1) {
    const clip = clips[index];
    addEvent(events, "background_cut", clip.timeline_in_frame, `${clip.clip_id}:background_cut`);
    backgroundCutFrames.add(clip.timeline_in_frame);
  }

  for (const clip of clips) {
    for (const caption of clip.captions ?? []) {
      const start = clampFrame(caption.in_frame, durationFrames);
      const end = clampFrame(caption.out_frame, durationFrames);
      if (end <= start) continue;
      addEvent(events, "caption_cue", start, `${clip.clip_id}:caption_in`);
      addEvent(events, "caption_cue", end, `${clip.clip_id}:caption_out`);
      addInterval(intervals, "caption_cue", start, end, `${clip.clip_id}:caption`);
    }

    const still = clip.still_image;
    const hasMotion = Boolean(still?.camera_motion || still?.ken_burns || still?.parallax || still?.motion_mode === "camera_motion");
    if (hasMotion) {
      const start = clampFrame(clip.timeline_in_frame, durationFrames);
      const end = clampFrame(clip.timeline_in_frame + clip.timeline_duration_frames, durationFrames);
      addEvent(events, "in_frame_motion", start, `${clip.clip_id}:motion_start`);
      addEvent(events, "in_frame_motion", end, `${clip.clip_id}:motion_end`);
      addInterval(intervals, "in_frame_motion", start, end, `${clip.clip_id}:motion`);
    }
  }

  const lyricMetadata = recordValue(timeline.metadata?.lyric_mv) as Partial<LyricMvTimelineMetadata> | undefined;
  for (const section of lyricMetadata?.music_sections ?? []) {
    if (!Number.isFinite(section.start_frame)) continue;
    const frame = clampFrame(section.start_frame, durationFrames);
    addEvent(events, "music_section", frame, `${section.id}:section_start`);
    musicEventFrames.set(frame, "music_section");
  }
  for (const event of lyricMetadata?.music_events ?? []) {
    if (!Number.isFinite(event.frame)) continue;
    const frame = clampFrame(event.frame, durationFrames);
    const component: LyricMvCadenceComponent = event.kind === "section_start" ? "music_section" : "music_onset";
    addEvent(events, component, frame, event.provenance);
    musicEventFrames.set(frame, component);
  }

  // Issue #35 remains the fallback receipt source for timelines compiled before
  // lyric_mv metadata was stamped. It is evidence, not a new timeline format.
  if ((lyricMetadata?.music_events?.length ?? 0) === 0) {
    const rhythm = recordValue(timeline.metadata?.rhythm_sync);
    const parity = recordValue(rhythm?.parity);
    const snaps = Array.isArray(rhythm?.snaps) ? rhythm.snaps : [];
    for (const raw of snaps) {
      const snap = recordValue(raw);
      if (!snap || !Number.isFinite(snap.target_frame)) continue;
      const component: LyricMvCadenceComponent = snap.target_kind === "section_start" || typeof snap.section_id === "string"
        ? "music_section"
        : "music_onset";
      const frame = clampFrame(snap.target_frame as number, durationFrames);
      addEvent(events, component, frame, "rhythm_sync.snaps");
      musicEventFrames.set(frame, component);
    }
    const sections = Array.isArray(parity?.sections) ? parity.sections : [];
    for (const raw of sections) {
      const section = recordValue(raw);
      if (!section || !Number.isFinite(section.section_start_frame)) continue;
      const frame = clampFrame(section.section_start_frame as number, durationFrames);
      addEvent(events, "music_section", frame, "rhythm_sync.parity.sections");
      musicEventFrames.set(frame, "music_section");
    }
  }

  for (const transition of timeline.transitions ?? []) {
    const toClip = clips.find((clip) => clip.clip_id === transition.to_clip_id);
    const startRaw = transition.start_frame ?? toClip?.timeline_in_frame;
    if (!Number.isFinite(startRaw)) continue;
    const start = clampFrame(startRaw as number, durationFrames);
    const duration = Math.max(0, Math.round(transition.duration_frames ?? transition.transition_frames ?? 0));
    const end = clampFrame(start + duration, durationFrames);
    addEvent(events, "transition", start, `${transition.transition_id}:start`);
    if (end > start) {
      addEvent(events, "transition", end, `${transition.transition_id}:end`);
      addInterval(intervals, "transition", start, end, transition.transition_id);
    }
  }

  const componentBreakdown = buildComponentBreakdown(events, intervals);
  const compositeFrames = [...new Set(
    LYRIC_MV_CADENCE_COMPONENTS.flatMap((component) => events[component].map((event) => event.frame)),
  )].filter((frame) => frame >= 0 && frame <= durationFrames).sort((a, b) => a - b);
  const composite = buildComposite(compositeFrames, durationFrames, thresholds, fps, clips[0]?.timeline_in_frame ?? 0);
  const staticRegions = buildStaticRegions(
    events,
    intervals,
    backgroundCutFrames,
    musicEventFrames,
    durationFrames,
  );
  const longHolds = findLongHolds(clips, thresholds.background_hold.intentional_long_hold_sec, fps);
  const degradedReasons: string[] = [];
  if (events.music_section.length === 0 && events.music_onset.length === 0) degradedReasons.push("music_section_and_onset_evidence_missing");
  if (staticRegions.fully_static_count > 0) degradedReasons.push("fully_static_regions_present");
  if (composite.event_count <= 1) degradedReasons.push("composite_cue_count_insufficient");

  const fail = composite.gaps_over_max.length > 0 || longHolds.some((hold) => hold.status !== "intentional");
  const warn = !fail && (composite.gaps_over_target.length > 0 || degradedReasons.length > 0);
  return {
    version: "lyric-mv-cadence/v1",
    profile_id: "lyric_mv",
    status: fail ? "fail" : warn ? "warn" : "pass",
    duration_frames: durationFrames,
    thresholds: structuredClone(thresholds),
    component_breakdown: componentBreakdown,
    composite,
    static_regions: staticRegions,
    long_holds: longHolds,
    degraded_reasons: degradedReasons,
  };
}

function emptyComponentBreakdown(): Record<LyricMvCadenceComponent, LyricMvComponentBreakdown> {
  return Object.fromEntries(LYRIC_MV_CADENCE_COMPONENTS.map((component) => [component, {
    event_count: 0,
    event_frames: [],
    events: [],
    active_intervals: [],
  }])) as unknown as Record<LyricMvCadenceComponent, LyricMvComponentBreakdown>;
}

function emptyEventMap(): Record<LyricMvCadenceComponent, ComponentEvent[]> {
  return Object.fromEntries(LYRIC_MV_CADENCE_COMPONENTS.map((component) => [component, []])) as unknown as Record<LyricMvCadenceComponent, ComponentEvent[]>;
}

function emptyIntervalMap(): Record<LyricMvCadenceComponent, ActiveInterval[]> {
  return Object.fromEntries(LYRIC_MV_CADENCE_COMPONENTS.map((component) => [component, []])) as unknown as Record<LyricMvCadenceComponent, ActiveInterval[]>;
}

function addEvent(
  events: Record<LyricMvCadenceComponent, ComponentEvent[]>,
  component: LyricMvCadenceComponent,
  frame: number,
  source: string,
): void {
  if (!events[component].some((event) => event.frame === frame)) {
    events[component].push({ frame, source });
  }
}

function addInterval(
  intervals: Record<LyricMvCadenceComponent, ActiveInterval[]>,
  component: LyricMvCadenceComponent,
  start: number,
  end: number,
  source: string,
): void {
  if (end > start) intervals[component].push({ start_frame: start, end_frame: end, source });
}

function buildComponentBreakdown(
  events: Record<LyricMvCadenceComponent, ComponentEvent[]>,
  intervals: Record<LyricMvCadenceComponent, ActiveInterval[]>,
): Record<LyricMvCadenceComponent, LyricMvComponentBreakdown> {
  return Object.fromEntries(LYRIC_MV_CADENCE_COMPONENTS.map((component) => {
    const componentEvents = events[component].slice().sort((a, b) => a.frame - b.frame || a.source.localeCompare(b.source));
    return [component, {
      event_count: componentEvents.length,
      event_frames: componentEvents.map((event) => event.frame),
      events: componentEvents,
      active_intervals: intervals[component].slice().sort((a, b) => a.start_frame - b.start_frame || a.end_frame - b.end_frame),
    }];
  })) as Record<LyricMvCadenceComponent, LyricMvComponentBreakdown>;
}

function emptyComposite(): LyricMvCadenceReport["composite"] {
  return {
    event_count: 0,
    event_frames: [],
    interval_count: 0,
    max_gap_frames: null,
    max_gap_sec: null,
    min_gap_frames: null,
    gaps_over_max: [],
    gaps_over_target: [],
    gaps_under_min: [],
  };
}

function buildComposite(
  eventFrames: number[],
  durationFrames: number,
  thresholds: LyricMvProfileThresholds,
  fps: number,
  clipStartFrame: number,
): LyricMvCadenceReport["composite"] {
  const boundaries = [...new Set([0, clipStartFrame, ...eventFrames, durationFrames])]
    .filter((frame) => frame >= 0 && frame <= durationFrames)
    .sort((a, b) => a - b);
  const gaps = boundaries.slice(1).map((end, index) => ({
    start_frame: boundaries[index],
    end_frame: end,
    duration_frames: end - boundaries[index],
  })).filter((gap) => gap.duration_frames > 0);
  const maxFrames = Math.max(1, Math.round(thresholds.music_section_cadence.max_sec * fps));
  const targetFrames = Math.max(1, Math.round(thresholds.music_section_cadence.target_sec * fps));
  const minFrames = Math.max(1, Math.round(thresholds.music_section_cadence.min_sec * fps));
  const maxGap = gaps.length > 0 ? Math.max(...gaps.map((gap) => gap.duration_frames)) : null;
  const minGap = gaps.length > 0 ? Math.min(...gaps.map((gap) => gap.duration_frames)) : null;
  return {
    event_count: eventFrames.length,
    event_frames: eventFrames,
    interval_count: gaps.length,
    max_gap_frames: maxGap,
    max_gap_sec: maxGap === null ? null : round(maxGap / fps),
    min_gap_frames: minGap,
    gaps_over_max: gaps.filter((gap) => gap.duration_frames > maxFrames),
    gaps_over_target: gaps.filter((gap) => gap.duration_frames > targetFrames),
    gaps_under_min: gaps.filter((gap) => gap.duration_frames < minFrames),
  };
}

function buildStaticRegions(
  events: Record<LyricMvCadenceComponent, ComponentEvent[]>,
  intervals: Record<LyricMvCadenceComponent, ActiveInterval[]>,
  backgroundCutFrames: Set<number>,
  musicEventFrames: Map<number, LyricMvCadenceComponent>,
  durationFrames: number,
): LyricMvCadenceReport["static_regions"] {
  const boundaries = [...new Set([
    0,
    durationFrames,
    ...LYRIC_MV_CADENCE_COMPONENTS.flatMap((component) => [
      ...events[component].map((event) => event.frame),
      ...intervals[component].flatMap((interval) => [interval.start_frame, interval.end_frame]),
    ]),
  ])].filter((frame) => frame >= 0 && frame <= durationFrames).sort((a, b) => a - b);
  const regions: LyricMvStaticRegion[] = [];
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const start = boundaries[index];
    const end = boundaries[index + 1];
    if (end <= start) continue;
    const changed = new Set<LyricMvCadenceComponent>();
    for (const component of ["caption_cue", "in_frame_motion", "transition"] as const) {
      if (intervals[component].some((interval) => interval.start_frame < end && interval.end_frame > start)) changed.add(component);
    }
    if (backgroundCutFrames.has(start)) changed.add("background_cut");
    const musicComponent = musicEventFrames.get(start);
    if (musicComponent) changed.add(musicComponent);
    const changedBy = [...changed].sort((a, b) => a.localeCompare(b));
    regions.push({
      start_frame: start,
      end_frame: end,
      duration_frames: end - start,
      changed_by: changedBy,
      fully_static: changedBy.length === 0,
    });
  }
  const fullyStaticCount = regions.filter((region) => region.fully_static).length;
  return {
    total_count: regions.length,
    fully_static_count: fullyStaticCount,
    changed_count: regions.length - fullyStaticCount,
    regions,
  };
}

function findLongHolds(
  clips: TimelineClip[],
  thresholdSec: number,
  fps: number,
): LyricMvLongHoldFinding[] {
  return clips
    .filter((clip) => clip.still_image && clip.timeline_duration_frames > thresholdSec * fps)
    .map((clip) => {
      const still = clip.still_image!;
      const reason = still.long_hold_reason ?? still.hold?.reason ?? null;
      const sectionId = still.hold?.section_id ?? still.hold_resolution?.section_id ?? null;
      const hasReason = typeof reason === "string" && reason.trim().length > 0;
      const hasSection = typeof sectionId === "string" && sectionId.trim().length > 0;
      const status = hasReason && hasSection
        ? "intentional"
        : !hasReason && !hasSection
          ? "missing_reason_and_section_binding"
          : !hasReason ? "missing_reason" : "missing_section_binding";
      return {
        clip_id: clip.clip_id,
        duration_frames: clip.timeline_duration_frames,
        duration_sec: round(clip.timeline_duration_frames / fps),
        threshold_sec: thresholdSec,
        reason,
        section_id: sectionId,
        status,
      };
    });
}

function getV1Clips(timeline: TimelineIR): TimelineClip[] {
  const track = timeline.tracks.video.find((item) => item.track_id === "V1") ?? timeline.tracks.video[0];
  return (track?.clips ?? []).slice().sort((a, b) => a.timeline_in_frame - b.timeline_in_frame || a.clip_id.localeCompare(b.clip_id)) as unknown as TimelineClip[];
}

function clampFrame(value: number, durationFrames: number): number {
  return Math.min(durationFrames, Math.max(0, Math.round(value)));
}

function recordValue(value: unknown): Record<string, any> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, any>
    : undefined;
}

function isLyricMvThresholds(value: unknown): value is LyricMvProfileThresholds {
  const record = recordValue(value);
  if (!record) return false;
  return LYRIC_MV_CADENCE_COMPONENTS.length > 0 &&
    threshold(record.background_hold, true) &&
    threshold(record.caption_cadence, false) &&
    threshold(record.music_section_cadence, false) &&
    threshold(record.motion_cadence, false);
}

function threshold(value: unknown, withLongHold: boolean): boolean {
  const record = recordValue(value);
  return Boolean(record &&
    finitePositive(record.min_sec) &&
    finitePositive(record.target_sec) &&
    finitePositive(record.max_sec) &&
    record.min_sec <= record.target_sec &&
    record.target_sec <= record.max_sec &&
    (!withLongHold || finitePositive(record.intentional_long_hold_sec)));
}

function finitePositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
