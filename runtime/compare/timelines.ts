import * as fs from "node:fs";
import * as path from "node:path";
import type { ClipOutput, TimelineIR, TrackOutput } from "../compiler/types.js";

type TrackKind = "video" | "audio" | "overlay" | "caption";
type ClipMatchStatus = "exact_match" | "variant_match";

interface ComparisonTimeline extends TimelineIR {
  tracks: TimelineIR["tracks"] & {
    overlay?: TrackOutput[];
    caption?: TrackOutput[];
  };
}

export interface LoadedTimelineContext {
  project_dir: string;
  project_name: string;
  timeline_path: string;
  timeline: ComparisonTimeline;
}

export interface FlattenedClip {
  comparison_key: string;
  source_key: string;
  occurrence_index: number;
  track_kind: TrackKind;
  track_id: string;
  clip_id: string;
  segment_id: string;
  asset_id: string;
  beat_id: string;
  role: string;
  src_in_us: number;
  src_out_us: number;
  timeline_in_frame: number;
  timeline_duration_frames: number;
  timeline_out_frame: number;
}

export interface BeatSummary {
  beat_id: string;
  label: string;
  order_index: number;
  start_frame: number;
  end_frame: number;
  duration_frames: number;
  clip_count: number;
  marker_frame: number | null;
}

export interface TimelineSummary {
  project_dir: string;
  project_name: string;
  timeline_path: string;
  project_id: string;
  sequence_name: string;
  fps: number;
  total_frames: number;
  total_duration_sec: number;
  clip_count: number;
  asset_ids: string[];
  track_clip_counts: Record<TrackKind, number>;
  clips: FlattenedClip[];
  beats: BeatSummary[];
}

export interface ClipSelectionStats {
  match_rate: number;
  shared_asset_count: number;
  union_asset_count: number;
  unique_asset_count_a: number;
  unique_asset_count_b: number;
  shared_asset_ids: string[];
  unique_asset_ids_a: string[];
  unique_asset_ids_b: string[];
}

export interface CommonClipComparison {
  pair_key: string;
  source_key: string;
  occurrence_index: number;
  track_kind: TrackKind;
  asset_id: string;
  segment_id: string;
  status: ClipMatchStatus;
  beat_changed: boolean;
  timeline_shift_frames: number;
  src_in_delta_us: number;
  src_out_delta_us: number;
  src_duration_delta_us: number;
  duration_delta_frames: number;
  clip_a: FlattenedClip;
  clip_b: FlattenedClip;
}

export interface BeatDifference {
  beat_id: string;
  status: "shared" | "only_a" | "only_b";
  label_a: string | null;
  label_b: string | null;
  order_index_a: number | null;
  order_index_b: number | null;
  start_frame_a: number | null;
  start_frame_b: number | null;
  duration_frames_a: number | null;
  duration_frames_b: number | null;
  clip_count_a: number | null;
  clip_count_b: number | null;
  start_delta_frames: number | null;
  duration_delta_frames: number | null;
  order_delta: number | null;
}

export interface TimelineComparisonSummary {
  clip_selection_match_rate: number;
  shared_asset_count: number;
  unique_asset_count_a: number;
  unique_asset_count_b: number;
  common_clip_count: number;
  exact_common_clip_count: number;
  variant_common_clip_count: number;
  unique_clip_count_a: number;
  unique_clip_count_b: number;
  beat_count_a: number;
  beat_count_b: number;
  shared_beat_count: number;
  unique_beat_count_a: number;
  unique_beat_count_b: number;
}

export interface TimelineComparisonReport {
  version: "1";
  generated_at: string;
  project_a: {
    name: string;
    project_id: string;
    project_dir: string;
    timeline_path: string;
  };
  project_b: {
    name: string;
    project_id: string;
    project_dir: string;
    timeline_path: string;
  };
  summary: TimelineComparisonSummary;
  clip_selection: ClipSelectionStats;
  timelines: {
    project_a: TimelineSummary;
    project_b: TimelineSummary;
  };
  beats: {
    differences: BeatDifference[];
    only_in_a: BeatDifference[];
    only_in_b: BeatDifference[];
  };
  common_clips: CommonClipComparison[];
  unique_clips: {
    project_a: FlattenedClip[];
    project_b: FlattenedClip[];
  };
}

export interface ComparisonArtifacts {
  report: TimelineComparisonReport;
  html: string;
  json_path: string;
  html_path: string;
}

const TRACK_KINDS: TrackKind[] = ["video", "audio", "overlay", "caption"];
const TRACK_KIND_ORDER: Record<TrackKind, number> = {
  video: 0,
  audio: 1,
  overlay: 2,
  caption: 3,
};

interface MarkerSummary {
  beat_id: string;
  label: string;
  frame: number;
}

interface MutableBeatSummary {
  beat_id: string;
  label: string;
  start_frame: number;
  end_frame: number;
  clip_count: number;
  marker_frame: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function ensureTrackArray(value: unknown, kind: TrackKind): TrackOutput[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(`Invalid timeline: tracks.${kind} must be an array`);
  }
  return value as TrackOutput[];
}

function sanitizeProjectName(name: string): string {
  const sanitized = name.trim().replace(/[^a-zA-Z0-9._-]+/g, "-");
  return sanitized.length > 0 ? sanitized : "project";
}

function sortClips(clips: FlattenedClip[]): FlattenedClip[] {
  return [...clips].sort((a, b) =>
    a.timeline_in_frame - b.timeline_in_frame ||
    a.timeline_out_frame - b.timeline_out_frame ||
    TRACK_KIND_ORDER[a.track_kind] - TRACK_KIND_ORDER[b.track_kind] ||
    a.track_id.localeCompare(b.track_id) ||
    a.clip_id.localeCompare(b.clip_id) ||
    a.segment_id.localeCompare(b.segment_id)
  );
}

function parseBeatIdFromMarkerLabel(label: string): string {
  const [rawBeatId] = label.split(":");
  return rawBeatId.trim();
}

function collectBeatMarkers(timeline: ComparisonTimeline): Map<string, MarkerSummary> {
  const markerMap = new Map<string, MarkerSummary>();
  for (const marker of timeline.markers ?? []) {
    if (marker.kind !== "beat") continue;
    const beatId = parseBeatIdFromMarkerLabel(marker.label);
    if (!beatId || markerMap.has(beatId)) continue;
    markerMap.set(beatId, {
      beat_id: beatId,
      label: marker.label,
      frame: marker.frame,
    });
  }
  return markerMap;
}

function flattenTimelineClips(timeline: ComparisonTimeline): FlattenedClip[] {
  const rawClips: Omit<FlattenedClip, "comparison_key" | "occurrence_index">[] = [];

  for (const kind of TRACK_KINDS) {
    const tracks = ensureTrackArray(timeline.tracks[kind], kind);
    for (const track of tracks) {
      for (const clip of track.clips) {
        const typedClip = clip as ClipOutput;
        rawClips.push({
          source_key: `${kind}:${typedClip.asset_id}:${typedClip.segment_id}`,
          track_kind: kind,
          track_id: track.track_id,
          clip_id: typedClip.clip_id,
          segment_id: typedClip.segment_id,
          asset_id: typedClip.asset_id,
          beat_id: typedClip.beat_id,
          role: typedClip.role,
          src_in_us: typedClip.src_in_us,
          src_out_us: typedClip.src_out_us,
          timeline_in_frame: typedClip.timeline_in_frame,
          timeline_duration_frames: typedClip.timeline_duration_frames,
          timeline_out_frame: typedClip.timeline_in_frame + typedClip.timeline_duration_frames,
        });
      }
    }
  }

  const sorted = rawClips.sort((a, b) =>
    a.timeline_in_frame - b.timeline_in_frame ||
    a.timeline_out_frame - b.timeline_out_frame ||
    TRACK_KIND_ORDER[a.track_kind] - TRACK_KIND_ORDER[b.track_kind] ||
    a.track_id.localeCompare(b.track_id) ||
    a.clip_id.localeCompare(b.clip_id) ||
    a.segment_id.localeCompare(b.segment_id)
  );

  const sourceCounts = new Map<string, number>();

  return sorted.map((clip) => {
    const occurrenceIndex = sourceCounts.get(clip.source_key) ?? 0;
    sourceCounts.set(clip.source_key, occurrenceIndex + 1);
    return {
      ...clip,
      occurrence_index: occurrenceIndex,
      comparison_key: `${clip.source_key}:${occurrenceIndex}`,
    };
  });
}

function buildBeatSummaries(
  timeline: ComparisonTimeline,
  clips: FlattenedClip[],
): BeatSummary[] {
  const markers = collectBeatMarkers(timeline);
  const beats = new Map<string, MutableBeatSummary>();

  for (const marker of markers.values()) {
    beats.set(marker.beat_id, {
      beat_id: marker.beat_id,
      label: marker.label,
      start_frame: marker.frame,
      end_frame: marker.frame,
      clip_count: 0,
      marker_frame: marker.frame,
    });
  }

  for (const clip of clips) {
    if (!clip.beat_id) continue;
    const existing = beats.get(clip.beat_id);
    if (existing) {
      existing.start_frame = Math.min(existing.start_frame, clip.timeline_in_frame);
      existing.end_frame = Math.max(existing.end_frame, clip.timeline_out_frame);
      existing.clip_count += 1;
    } else {
      beats.set(clip.beat_id, {
        beat_id: clip.beat_id,
        label: clip.beat_id,
        start_frame: clip.timeline_in_frame,
        end_frame: clip.timeline_out_frame,
        clip_count: 1,
        marker_frame: null,
      });
    }
  }

  return [...beats.values()]
    .sort((a, b) =>
      a.start_frame - b.start_frame ||
      (a.marker_frame ?? Number.MAX_SAFE_INTEGER) - (b.marker_frame ?? Number.MAX_SAFE_INTEGER) ||
      a.beat_id.localeCompare(b.beat_id)
    )
    .map((beat, index) => ({
      beat_id: beat.beat_id,
      label: beat.label,
      order_index: index,
      start_frame: beat.start_frame,
      end_frame: beat.end_frame,
      duration_frames: Math.max(beat.end_frame - beat.start_frame, 0),
      clip_count: beat.clip_count,
      marker_frame: beat.marker_frame,
    }));
}

function summarizeTimeline(context: LoadedTimelineContext): TimelineSummary {
  const clips = flattenTimelineClips(context.timeline);
  const beats = buildBeatSummaries(context.timeline, clips);
  const fps = context.timeline.sequence.fps_num / context.timeline.sequence.fps_den;
  const totalFrames = Math.max(
    0,
    ...clips.map((clip) => clip.timeline_out_frame),
    ...beats.map((beat) => beat.end_frame),
  );
  const assetIds = [...new Set(clips.map((clip) => clip.asset_id))].sort((a, b) => a.localeCompare(b));
  const trackClipCounts = TRACK_KINDS.reduce<Record<TrackKind, number>>(
    (acc, kind) => {
      acc[kind] = clips.filter((clip) => clip.track_kind === kind).length;
      return acc;
    },
    {
      video: 0,
      audio: 0,
      overlay: 0,
      caption: 0,
    },
  );

  return {
    project_dir: context.project_dir,
    project_name: context.project_name,
    timeline_path: context.timeline_path,
    project_id: context.timeline.project_id,
    sequence_name: context.timeline.sequence.name,
    fps,
    total_frames: totalFrames,
    total_duration_sec: fps > 0 ? totalFrames / fps : 0,
    clip_count: clips.length,
    asset_ids: assetIds,
    track_clip_counts: trackClipCounts,
    clips,
    beats,
  };
}

function buildSourceClipMap(clips: FlattenedClip[]): Map<string, FlattenedClip[]> {
  const map = new Map<string, FlattenedClip[]>();
  for (const clip of clips) {
    const group = map.get(clip.source_key) ?? [];
    group.push(clip);
    map.set(clip.source_key, group);
  }
  return map;
}

function buildClipSelectionStats(
  summaryA: TimelineSummary,
  summaryB: TimelineSummary,
): ClipSelectionStats {
  const assetsA = new Set(summaryA.asset_ids);
  const assetsB = new Set(summaryB.asset_ids);
  const shared = [...assetsA].filter((assetId) => assetsB.has(assetId)).sort((a, b) => a.localeCompare(b));
  const uniqueA = [...assetsA].filter((assetId) => !assetsB.has(assetId)).sort((a, b) => a.localeCompare(b));
  const uniqueB = [...assetsB].filter((assetId) => !assetsA.has(assetId)).sort((a, b) => a.localeCompare(b));
  const unionCount = new Set([...assetsA, ...assetsB]).size;

  return {
    match_rate: unionCount === 0 ? 1 : shared.length / unionCount,
    shared_asset_count: shared.length,
    union_asset_count: unionCount,
    unique_asset_count_a: uniqueA.length,
    unique_asset_count_b: uniqueB.length,
    shared_asset_ids: shared,
    unique_asset_ids_a: uniqueA,
    unique_asset_ids_b: uniqueB,
  };
}

function compareCommonAndUniqueClips(
  summaryA: TimelineSummary,
  summaryB: TimelineSummary,
): {
  commonClips: CommonClipComparison[];
  uniqueA: FlattenedClip[];
  uniqueB: FlattenedClip[];
} {
  const mapA = buildSourceClipMap(summaryA.clips);
  const mapB = buildSourceClipMap(summaryB.clips);
  const sharedKeys = [...mapA.keys()].filter((key) => mapB.has(key)).sort((a, b) => a.localeCompare(b));
  const uniqueA: FlattenedClip[] = [];
  const uniqueB: FlattenedClip[] = [];
  const commonClips: CommonClipComparison[] = [];

  for (const key of sharedKeys) {
    const clipsA = mapA.get(key) ?? [];
    const clipsB = mapB.get(key) ?? [];
    const pairCount = Math.min(clipsA.length, clipsB.length);

    for (let index = 0; index < pairCount; index++) {
      const clipA = clipsA[index];
      const clipB = clipsB[index];
      const beatChanged = clipA.beat_id !== clipB.beat_id;
      const timelineShiftFrames = clipB.timeline_in_frame - clipA.timeline_in_frame;
      const srcInDelta = clipB.src_in_us - clipA.src_in_us;
      const srcOutDelta = clipB.src_out_us - clipA.src_out_us;
      const srcDurationDelta =
        (clipB.src_out_us - clipB.src_in_us) - (clipA.src_out_us - clipA.src_in_us);
      const durationDeltaFrames = clipB.timeline_duration_frames - clipA.timeline_duration_frames;
      const status: ClipMatchStatus =
        beatChanged ||
          timelineShiftFrames !== 0 ||
          srcInDelta !== 0 ||
          srcOutDelta !== 0 ||
          durationDeltaFrames !== 0
          ? "variant_match"
          : "exact_match";

      commonClips.push({
        pair_key: `${key}:${index}`,
        source_key: key,
        occurrence_index: index,
        track_kind: clipA.track_kind,
        asset_id: clipA.asset_id,
        segment_id: clipA.segment_id,
        status,
        beat_changed: beatChanged,
        timeline_shift_frames: timelineShiftFrames,
        src_in_delta_us: srcInDelta,
        src_out_delta_us: srcOutDelta,
        src_duration_delta_us: srcDurationDelta,
        duration_delta_frames: durationDeltaFrames,
        clip_a: clipA,
        clip_b: clipB,
      });
    }

    uniqueA.push(...clipsA.slice(pairCount));
    uniqueB.push(...clipsB.slice(pairCount));
  }

  for (const [key, clipsA] of mapA.entries()) {
    if (mapB.has(key)) continue;
    uniqueA.push(...clipsA);
  }

  for (const [key, clipsB] of mapB.entries()) {
    if (mapA.has(key)) continue;
    uniqueB.push(...clipsB);
  }

  return {
    commonClips: commonClips.sort((a, b) =>
      a.clip_a.timeline_in_frame - b.clip_a.timeline_in_frame ||
      a.clip_b.timeline_in_frame - b.clip_b.timeline_in_frame ||
      a.source_key.localeCompare(b.source_key)
    ),
    uniqueA: sortClips(uniqueA),
    uniqueB: sortClips(uniqueB),
  };
}

function compareBeats(
  summaryA: TimelineSummary,
  summaryB: TimelineSummary,
): {
  differences: BeatDifference[];
  onlyInA: BeatDifference[];
  onlyInB: BeatDifference[];
} {
  const beatsA = new Map(summaryA.beats.map((beat) => [beat.beat_id, beat]));
  const beatsB = new Map(summaryB.beats.map((beat) => [beat.beat_id, beat]));
  const beatIds = [...new Set([...beatsA.keys(), ...beatsB.keys()])].sort((a, b) => {
    const orderA = beatsA.get(a)?.order_index ?? Number.MAX_SAFE_INTEGER;
    const orderB = beatsB.get(a)?.order_index ?? Number.MAX_SAFE_INTEGER;
    const orderC = beatsA.get(b)?.order_index ?? Number.MAX_SAFE_INTEGER;
    const orderD = beatsB.get(b)?.order_index ?? Number.MAX_SAFE_INTEGER;
    return Math.min(orderA, orderB) - Math.min(orderC, orderD) || a.localeCompare(b);
  });

  const differences: BeatDifference[] = beatIds.map((beatId) => {
    const beatA = beatsA.get(beatId) ?? null;
    const beatB = beatsB.get(beatId) ?? null;

    if (beatA && beatB) {
      return {
        beat_id: beatId,
        status: "shared",
        label_a: beatA.label,
        label_b: beatB.label,
        order_index_a: beatA.order_index,
        order_index_b: beatB.order_index,
        start_frame_a: beatA.start_frame,
        start_frame_b: beatB.start_frame,
        duration_frames_a: beatA.duration_frames,
        duration_frames_b: beatB.duration_frames,
        clip_count_a: beatA.clip_count,
        clip_count_b: beatB.clip_count,
        start_delta_frames: beatB.start_frame - beatA.start_frame,
        duration_delta_frames: beatB.duration_frames - beatA.duration_frames,
        order_delta: beatB.order_index - beatA.order_index,
      };
    }

    if (beatA) {
      return {
        beat_id: beatId,
        status: "only_a",
        label_a: beatA.label,
        label_b: null,
        order_index_a: beatA.order_index,
        order_index_b: null,
        start_frame_a: beatA.start_frame,
        start_frame_b: null,
        duration_frames_a: beatA.duration_frames,
        duration_frames_b: null,
        clip_count_a: beatA.clip_count,
        clip_count_b: null,
        start_delta_frames: null,
        duration_delta_frames: null,
        order_delta: null,
      };
    }

    const onlyB = beatB!;
    return {
      beat_id: beatId,
      status: "only_b",
      label_a: null,
      label_b: onlyB.label,
      order_index_a: null,
      order_index_b: onlyB.order_index,
      start_frame_a: null,
      start_frame_b: onlyB.start_frame,
      duration_frames_a: null,
      duration_frames_b: onlyB.duration_frames,
      clip_count_a: null,
      clip_count_b: onlyB.clip_count,
      start_delta_frames: null,
      duration_delta_frames: null,
      order_delta: null,
    };
  });

  return {
    differences,
    onlyInA: differences.filter((beat) => beat.status === "only_a"),
    onlyInB: differences.filter((beat) => beat.status === "only_b"),
  };
}

function buildSummary(
  clipSelection: ClipSelectionStats,
  commonClips: CommonClipComparison[],
  uniqueA: FlattenedClip[],
  uniqueB: FlattenedClip[],
  beatDiffs: BeatDifference[],
  summaryA: TimelineSummary,
  summaryB: TimelineSummary,
): TimelineComparisonSummary {
  const exactCount = commonClips.filter((clip) => clip.status === "exact_match").length;
  const variantCount = commonClips.length - exactCount;
  const sharedBeatCount = beatDiffs.filter((beat) => beat.status === "shared").length;
  const uniqueBeatCountA = beatDiffs.filter((beat) => beat.status === "only_a").length;
  const uniqueBeatCountB = beatDiffs.filter((beat) => beat.status === "only_b").length;

  return {
    clip_selection_match_rate: clipSelection.match_rate,
    shared_asset_count: clipSelection.shared_asset_count,
    unique_asset_count_a: clipSelection.unique_asset_count_a,
    unique_asset_count_b: clipSelection.unique_asset_count_b,
    common_clip_count: commonClips.length,
    exact_common_clip_count: exactCount,
    variant_common_clip_count: variantCount,
    unique_clip_count_a: uniqueA.length,
    unique_clip_count_b: uniqueB.length,
    beat_count_a: summaryA.beats.length,
    beat_count_b: summaryB.beats.length,
    shared_beat_count: sharedBeatCount,
    unique_beat_count_a: uniqueBeatCountA,
    unique_beat_count_b: uniqueBeatCountB,
  };
}

export function resolveProjectDirectory(input: string, cwd = process.cwd()): string {
  const direct = path.resolve(cwd, input);
  if (fs.existsSync(direct)) {
    return direct;
  }

  const underProjects = path.resolve(cwd, "projects", input);
  if (fs.existsSync(underProjects)) {
    return underProjects;
  }

  throw new Error(`Project directory not found: ${input}`);
}

export function loadTimelineContext(projectInput: string, cwd = process.cwd()): LoadedTimelineContext {
  const projectDir = resolveProjectDirectory(projectInput, cwd);
  const timelinePath = path.join(projectDir, "05_timeline", "timeline.json");

  if (!fs.existsSync(timelinePath)) {
    throw new Error(`timeline.json not found: ${timelinePath}`);
  }

  const parsed = JSON.parse(fs.readFileSync(timelinePath, "utf-8")) as unknown;
  if (!isRecord(parsed) || !isRecord(parsed.tracks)) {
    throw new Error(`Invalid timeline.json: ${timelinePath}`);
  }

  return {
    project_dir: projectDir,
    project_name: path.basename(projectDir),
    timeline_path: timelinePath,
    timeline: parsed as unknown as ComparisonTimeline,
  };
}

export function compareTimelineContexts(
  contextA: LoadedTimelineContext,
  contextB: LoadedTimelineContext,
): TimelineComparisonReport {
  const summaryA = summarizeTimeline(contextA);
  const summaryB = summarizeTimeline(contextB);
  const clipSelection = buildClipSelectionStats(summaryA, summaryB);
  const clipComparison = compareCommonAndUniqueClips(summaryA, summaryB);
  const beatComparison = compareBeats(summaryA, summaryB);
  const summary = buildSummary(
    clipSelection,
    clipComparison.commonClips,
    clipComparison.uniqueA,
    clipComparison.uniqueB,
    beatComparison.differences,
    summaryA,
    summaryB,
  );

  return {
    version: "1",
    generated_at: new Date().toISOString(),
    project_a: {
      name: contextA.project_name,
      project_id: contextA.timeline.project_id,
      project_dir: contextA.project_dir,
      timeline_path: contextA.timeline_path,
    },
    project_b: {
      name: contextB.project_name,
      project_id: contextB.timeline.project_id,
      project_dir: contextB.project_dir,
      timeline_path: contextB.timeline_path,
    },
    summary,
    clip_selection: clipSelection,
    timelines: {
      project_a: summaryA,
      project_b: summaryB,
    },
    beats: {
      differences: beatComparison.differences,
      only_in_a: beatComparison.onlyInA,
      only_in_b: beatComparison.onlyInB,
    },
    common_clips: clipComparison.commonClips,
    unique_clips: {
      project_a: clipComparison.uniqueA,
      project_b: clipComparison.uniqueB,
    },
  };
}

export function compareProjectTimelines(
  projectAInput: string,
  projectBInput: string,
  cwd = process.cwd(),
): TimelineComparisonReport {
  const contextA = loadTimelineContext(projectAInput, cwd);
  const contextB = loadTimelineContext(projectBInput, cwd);
  return compareTimelineContexts(contextA, contextB);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function formatFrames(frames: number | null): string {
  return frames == null ? "—" : `${frames}f`;
}

function formatUs(us: number | null): string {
  return us == null ? "—" : `${(us / 1_000_000).toFixed(2)}s`;
}

function formatSignedNumber(value: number | null, suffix = ""): string {
  if (value == null) return "—";
  if (value === 0) return `0${suffix}`;
  return `${value > 0 ? "+" : ""}${value}${suffix}`;
}

function formatSignedUs(value: number): string {
  if (value === 0) return "0.00s";
  return `${value > 0 ? "+" : ""}${(value / 1_000_000).toFixed(2)}s`;
}

function formatSeconds(seconds: number): string {
  return `${seconds.toFixed(2)}s`;
}

function beatColor(beatId: string): string {
  let hash = 0;
  for (let i = 0; i < beatId.length; i++) {
    hash = (hash * 31 + beatId.charCodeAt(i)) % 360;
  }
  return `hsl(${hash} 70% 58%)`;
}

function clipStatusClass(status: ClipMatchStatus | "unique"): string {
  if (status === "exact_match") return "status-match";
  if (status === "variant_match") return "status-variant";
  return "status-unique";
}

function renderTimelineBars(summary: TimelineSummary): string {
  const denominator = Math.max(summary.total_frames, 1);

  if (summary.beats.length === 0) {
    return '<p class="empty-state">No beat data.</p>';
  }

  return [
    '<div class="timeline-bars">',
    ...summary.beats.map((beat) => {
      const leftPct = (beat.start_frame / denominator) * 100;
      const widthPct = Math.max((beat.duration_frames / denominator) * 100, 1.5);
      return `
        <div class="beat-row">
          <div class="beat-meta">
            <strong>${escapeHtml(beat.beat_id)}</strong>
            <span>${escapeHtml(beat.label)}</span>
          </div>
          <div class="beat-track">
            <div
              class="beat-bar"
              style="left:${leftPct.toFixed(3)}%;width:${widthPct.toFixed(3)}%;background:${beatColor(beat.beat_id)};"
              title="${escapeHtml(beat.beat_id)} ${beat.start_frame}f-${beat.end_frame}f"
            ></div>
          </div>
          <div class="beat-stats">${formatFrames(beat.duration_frames)} / ${formatSeconds(beat.duration_frames / summary.fps)}</div>
        </div>
      `;
    }),
    "</div>",
  ].join("");
}

function renderClipList(
  summary: TimelineSummary,
  statuses: Map<string, ClipMatchStatus | "unique">,
): string {
  if (summary.clips.length === 0) {
    return '<p class="empty-state">No clips.</p>';
  }

  return [
    '<div class="clip-list">',
    ...summary.clips.map((clip) => {
      const status = statuses.get(clip.comparison_key) ?? "unique";
      return `
        <div class="clip-card ${clipStatusClass(status)}">
          <div class="clip-card-header">
            <strong>${escapeHtml(clip.asset_id)}</strong>
            <span>${escapeHtml(clip.segment_id)}</span>
          </div>
          <div class="clip-card-body">
            <span>${escapeHtml(clip.track_id)} / ${escapeHtml(clip.beat_id || "no-beat")} / ${escapeHtml(clip.role)}</span>
            <span>src ${formatUs(clip.src_in_us)} - ${formatUs(clip.src_out_us)}</span>
            <span>tl ${formatFrames(clip.timeline_in_frame)} + ${formatFrames(clip.timeline_duration_frames)}</span>
          </div>
        </div>
      `;
    }),
    "</div>",
  ].join("");
}

function renderUniqueList(title: string, clips: FlattenedClip[]): string {
  return `
    <div class="panel">
      <h3>${escapeHtml(title)}</h3>
      ${
        clips.length === 0
          ? '<p class="empty-state">None.</p>'
          : `
            <ul class="plain-list">
              ${clips.map((clip) => `
                <li>${escapeHtml(clip.asset_id)} / ${escapeHtml(clip.segment_id)} / ${escapeHtml(clip.track_id)} / ${escapeHtml(clip.beat_id || "no-beat")}</li>
              `).join("")}
            </ul>
          `
      }
    </div>
  `;
}

function renderCommonClipTable(commonClips: CommonClipComparison[]): string {
  if (commonClips.length === 0) {
    return '<p class="empty-state">No common clips.</p>';
  }

  return `
    <table>
      <thead>
        <tr>
          <th>Status</th>
          <th>Source</th>
          <th>Beat A</th>
          <th>Beat B</th>
          <th>Shift</th>
          <th>In Δ</th>
          <th>Out Δ</th>
          <th>Dur Δ</th>
        </tr>
      </thead>
      <tbody>
        ${commonClips.map((clip) => `
          <tr class="${clipStatusClass(clip.status)}">
            <td>${clip.status === "exact_match" ? "match" : "variant"}</td>
            <td>${escapeHtml(clip.asset_id)} / ${escapeHtml(clip.segment_id)} / ${escapeHtml(clip.track_kind)}</td>
            <td>${escapeHtml(clip.clip_a.beat_id || "no-beat")}</td>
            <td>${escapeHtml(clip.clip_b.beat_id || "no-beat")}</td>
            <td>${formatSignedNumber(clip.timeline_shift_frames, "f")}</td>
            <td>${formatSignedUs(clip.src_in_delta_us)}</td>
            <td>${formatSignedUs(clip.src_out_delta_us)}</td>
            <td>${formatSignedNumber(clip.duration_delta_frames, "f")}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

function renderBeatTable(differences: BeatDifference[]): string {
  if (differences.length === 0) {
    return '<p class="empty-state">No beat differences.</p>';
  }

  return `
    <table>
      <thead>
        <tr>
          <th>Beat</th>
          <th>Status</th>
          <th>Order</th>
          <th>Start A</th>
          <th>Start B</th>
          <th>Start Δ</th>
          <th>Dur A</th>
          <th>Dur B</th>
          <th>Dur Δ</th>
        </tr>
      </thead>
      <tbody>
        ${differences.map((beat) => {
          const rowClass = beat.status === "shared"
            ? (beat.start_delta_frames === 0 && beat.duration_delta_frames === 0 && beat.order_delta === 0
              ? "status-match"
              : "status-variant")
            : "status-unique";

          return `
            <tr class="${rowClass}">
              <td>${escapeHtml(beat.beat_id)}</td>
              <td>${escapeHtml(beat.status)}</td>
              <td>${beat.order_index_a ?? "—"} / ${beat.order_index_b ?? "—"}</td>
              <td>${formatFrames(beat.start_frame_a)}</td>
              <td>${formatFrames(beat.start_frame_b)}</td>
              <td>${formatSignedNumber(beat.start_delta_frames, "f")}</td>
              <td>${formatFrames(beat.duration_frames_a)}</td>
              <td>${formatFrames(beat.duration_frames_b)}</td>
              <td>${formatSignedNumber(beat.duration_delta_frames, "f")}</td>
            </tr>
          `;
        }).join("")}
      </tbody>
    </table>
  `;
}

export function generateComparisonHtml(report: TimelineComparisonReport): string {
  const statusA = new Map<string, ClipMatchStatus | "unique">();
  const statusB = new Map<string, ClipMatchStatus | "unique">();

  for (const clip of report.common_clips) {
    statusA.set(clip.clip_a.comparison_key, clip.status);
    statusB.set(clip.clip_b.comparison_key, clip.status);
  }

  for (const clip of report.unique_clips.project_a) {
    statusA.set(clip.comparison_key, "unique");
  }

  for (const clip of report.unique_clips.project_b) {
    statusB.set(clip.comparison_key, "unique");
  }

  return `<!DOCTYPE html>
<html lang="ja">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Timeline Comparison: ${escapeHtml(report.project_a.name)} vs ${escapeHtml(report.project_b.name)}</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f6f5ef;
        --panel: #ffffff;
        --line: #ddd6c8;
        --ink: #1d1b16;
        --muted: #6a6458;
        --match: #dff4df;
        --variant: #fff2c7;
        --unique: #f8d8d6;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: "SF Pro Text", "Hiragino Sans", sans-serif;
        background: linear-gradient(180deg, #faf8f1 0%, #f1ede2 100%);
        color: var(--ink);
      }
      main {
        max-width: 1440px;
        margin: 0 auto;
        padding: 32px 24px 48px;
      }
      h1, h2, h3 { margin: 0 0 12px; }
      p { margin: 0; }
      .subtle { color: var(--muted); }
      .summary-grid, .side-by-side {
        display: grid;
        gap: 16px;
      }
      .summary-grid {
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
        margin: 20px 0 28px;
      }
      .side-by-side {
        grid-template-columns: repeat(2, minmax(0, 1fr));
        margin: 16px 0 24px;
      }
      .panel, .stat-card {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 18px;
        padding: 18px;
        box-shadow: 0 10px 24px rgba(39, 29, 12, 0.06);
      }
      .stat-card strong {
        display: block;
        font-size: 28px;
        margin-bottom: 8px;
      }
      .stat-card span {
        color: var(--muted);
        font-size: 13px;
      }
      .timeline-bars {
        display: flex;
        flex-direction: column;
        gap: 12px;
      }
      .beat-row {
        display: grid;
        grid-template-columns: 120px minmax(0, 1fr) 110px;
        gap: 12px;
        align-items: center;
      }
      .beat-meta {
        display: flex;
        flex-direction: column;
        font-size: 12px;
      }
      .beat-meta span { color: var(--muted); }
      .beat-track {
        position: relative;
        min-height: 22px;
        border-radius: 999px;
        background: #efeadb;
        overflow: hidden;
      }
      .beat-bar {
        position: absolute;
        top: 0;
        bottom: 0;
        border-radius: 999px;
      }
      .beat-stats {
        text-align: right;
        font-size: 12px;
        color: var(--muted);
      }
      .clip-list {
        display: flex;
        flex-direction: column;
        gap: 10px;
      }
      .clip-card {
        border-radius: 14px;
        padding: 12px 14px;
        border: 1px solid transparent;
      }
      .clip-card-header {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        margin-bottom: 6px;
      }
      .clip-card-body {
        display: flex;
        flex-direction: column;
        gap: 4px;
        font-size: 13px;
        color: var(--muted);
      }
      .status-match { background: var(--match); }
      .status-variant { background: var(--variant); }
      .status-unique { background: var(--unique); }
      table {
        width: 100%;
        border-collapse: collapse;
        font-size: 13px;
      }
      th, td {
        padding: 10px 12px;
        border-bottom: 1px solid var(--line);
        text-align: left;
        vertical-align: top;
      }
      thead th {
        color: var(--muted);
        font-weight: 600;
        background: #faf7ef;
      }
      .plain-list {
        margin: 0;
        padding-left: 18px;
      }
      .plain-list li + li {
        margin-top: 8px;
      }
      .empty-state {
        color: var(--muted);
        font-size: 14px;
      }
      .legend {
        display: flex;
        gap: 10px;
        flex-wrap: wrap;
        margin: 10px 0 22px;
      }
      .legend span {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        font-size: 13px;
        color: var(--muted);
      }
      .legend i {
        width: 12px;
        height: 12px;
        border-radius: 999px;
        display: inline-block;
      }
      @media (max-width: 960px) {
        .side-by-side {
          grid-template-columns: 1fr;
        }
        .beat-row {
          grid-template-columns: 1fr;
        }
        .beat-stats {
          text-align: left;
        }
      }
    </style>
  </head>
  <body>
    <main>
      <header class="panel">
        <h1>${escapeHtml(report.project_a.name)} vs ${escapeHtml(report.project_b.name)}</h1>
        <p class="subtle">Generated at ${escapeHtml(report.generated_at)}</p>
        <p class="subtle">${escapeHtml(report.project_a.timeline_path)} vs ${escapeHtml(report.project_b.timeline_path)}</p>
      </header>

      <section class="summary-grid">
        <div class="stat-card">
          <strong>${formatPercent(report.summary.clip_selection_match_rate)}</strong>
          <span>Clip selection match rate</span>
        </div>
        <div class="stat-card">
          <strong>${report.summary.common_clip_count}</strong>
          <span>Common clips</span>
        </div>
        <div class="stat-card">
          <strong>${report.summary.exact_common_clip_count}</strong>
          <span>Exact matches</span>
        </div>
        <div class="stat-card">
          <strong>${report.summary.variant_common_clip_count}</strong>
          <span>Variant matches</span>
        </div>
        <div class="stat-card">
          <strong>${report.summary.unique_clip_count_a} / ${report.summary.unique_clip_count_b}</strong>
          <span>Unique clips A / B</span>
        </div>
        <div class="stat-card">
          <strong>${report.summary.beat_count_a} / ${report.summary.beat_count_b}</strong>
          <span>Beat count A / B</span>
        </div>
      </section>

      <div class="legend">
        <span><i style="background:var(--match)"></i>Match</span>
        <span><i style="background:var(--variant)"></i>Shared source with trim/placement diff</span>
        <span><i style="background:var(--unique)"></i>Only in one timeline</span>
      </div>

      <section class="side-by-side">
        <div class="panel">
          <h2>${escapeHtml(report.project_a.name)} timeline</h2>
          <p class="subtle">${formatFrames(report.timelines.project_a.total_frames)} / ${formatSeconds(report.timelines.project_a.total_duration_sec)}</p>
          ${renderTimelineBars(report.timelines.project_a)}
        </div>
        <div class="panel">
          <h2>${escapeHtml(report.project_b.name)} timeline</h2>
          <p class="subtle">${formatFrames(report.timelines.project_b.total_frames)} / ${formatSeconds(report.timelines.project_b.total_duration_sec)}</p>
          ${renderTimelineBars(report.timelines.project_b)}
        </div>
      </section>

      <section class="side-by-side">
        <div class="panel">
          <h2>${escapeHtml(report.project_a.name)} clips</h2>
          ${renderClipList(report.timelines.project_a, statusA)}
        </div>
        <div class="panel">
          <h2>${escapeHtml(report.project_b.name)} clips</h2>
          ${renderClipList(report.timelines.project_b, statusB)}
        </div>
      </section>

      <section class="side-by-side">
        ${renderUniqueList(`Only in ${report.project_a.name}`, report.unique_clips.project_a)}
        ${renderUniqueList(`Only in ${report.project_b.name}`, report.unique_clips.project_b)}
      </section>

      <section class="panel">
        <h2>Common clip trim / placement differences</h2>
        ${renderCommonClipTable(report.common_clips)}
      </section>

      <section class="panel" style="margin-top: 24px;">
        <h2>Beat structure differences</h2>
        ${renderBeatTable(report.beats.differences)}
      </section>
    </main>
  </body>
</html>`;
}

export function writeComparisonArtifacts(
  report: TimelineComparisonReport,
  html: string,
): { json_path: string; html_path: string } {
  const outputDir = report.project_a.project_dir;
  const targetName = sanitizeProjectName(report.project_b.name);
  const jsonPath = path.join(outputDir, `comparison-${targetName}.json`);
  const htmlPath = path.join(outputDir, `comparison-${targetName}.html`);

  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), "utf-8");
  fs.writeFileSync(htmlPath, html, "utf-8");

  return {
    json_path: jsonPath,
    html_path: htmlPath,
  };
}

export function compareAndWriteProjectTimelines(
  projectAInput: string,
  projectBInput: string,
  cwd = process.cwd(),
): ComparisonArtifacts {
  const report = compareProjectTimelines(projectAInput, projectBInput, cwd);
  const html = generateComparisonHtml(report);
  const paths = writeComparisonArtifacts(report, html);
  return {
    report,
    html,
    json_path: paths.json_path,
    html_path: paths.html_path,
  };
}
