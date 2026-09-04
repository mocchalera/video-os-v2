import { createHash } from "node:crypto";

/** A reduced rational value. All arithmetic in this module is integer based. */
export interface Rational {
  numerator: bigint;
  denominator: bigint;
}

export type IntegerLike = bigint | number | string;
export type RationalLike = Rational | IntegerLike | { numerator: IntegerLike; denominator: IntegerLike };

export interface TimelineOffsetClipInput {
  clip_id: string;
  asset_id: string;
  segment_id?: string;
  src_in_us: IntegerLike;
  src_out_us: IntegerLike;
  timeline_in_frame: IntegerLike;
  timeline_duration_frames: IntegerLike;
  /** Playback rate. 1 means real time; timeline time is source delta / speed. */
  speed?: RationalLike;
  track_id?: string;
  track_kind?: "video" | "audio" | "overlay" | "caption";
  role?: string;
}

export interface TimelineOffsetMapClip {
  clip_id: string;
  asset_id: string;
  segment_id?: string;
  src_in_us: string;
  src_out_us: string;
  timeline_in_frame: string;
  timeline_duration_frames: string;
  speed: { numerator: string; denominator: string };
  track_id?: string;
  track_kind?: TimelineOffsetClipInput["track_kind"];
  role?: string;
}

export interface TimelineOffsetMap {
  version: "timeline-offset-map/v1";
  fps: { numerator: string; denominator: string };
  clips: TimelineOffsetMapClip[];
  /** A1 is authoritative for dialogue captions whenever it has a matching clip. */
  dialogue_authority: "A1" | "legacy-role";
  fingerprint: string;
}

export interface SourceWordRef {
  word: string;
  start_us: number;
  end_us: number;
  confidence?: number;
}

export interface OffsetProjectionSegment {
  /** The canonical clip occurrence, never a source-only asset identity. */
  occurrence_id: string;
  clip_id: string;
  source_start_us: number;
  source_end_us: number;
  timeline_start_frame: number;
  timeline_end_frame: number;
}

export interface OffsetProjection {
  timeline_in_frame: number;
  timeline_duration_frames: number;
  segments: OffsetProjectionSegment[];
  clip_map_refs: string[];
  occurrence_refs: string[];
  source_word_refs: SourceWordRef[];
  authority: "A1" | "legacy-role" | "fallback";
  confidence: number;
  status: "exact" | "fallback" | "blocked" | "invalid";
  fallback_reason?: string;
}

const MICROSECONDS = 1_000_000n;

function abs(value: bigint): bigint { return value < 0n ? -value : value; }

function gcd(left: bigint, right: bigint): bigint {
  let a = abs(left);
  let b = abs(right);
  while (b !== 0n) [a, b] = [b, a % b];
  return a || 1n;
}

export function rational(numerator: IntegerLike, denominator: IntegerLike = 1): Rational {
  const n = toBigInt(numerator, "rational numerator");
  const d = toBigInt(denominator, "rational denominator");
  if (d === 0n) throw new Error("rational denominator must not be zero");
  const sign = d < 0n ? -1n : 1n;
  const divisor = gcd(n, d);
  return { numerator: (n * sign) / divisor, denominator: (d * sign) / divisor };
}

export function rationalFrom(value: RationalLike | undefined, fallback: Rational = rational(1)): Rational {
  if (value === undefined) return fallback;
  if (typeof value === "object" && value !== null && "numerator" in value && "denominator" in value) {
    return rational(value.numerator, value.denominator);
  }
  return rational(value);
}

function toBigInt(value: IntegerLike, label: string): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error(`${label} must be a safe integer`);
    return BigInt(value);
  }
  if (!/^-?\d+$/.test(value)) throw new Error(`${label} must be an integer`);
  return BigInt(value);
}

function rationalToJSON(value: Rational): { numerator: string; denominator: string } {
  return { numerator: value.numerator.toString(), denominator: value.denominator.toString() };
}

function canonical(value: unknown): string {
  if (typeof value === "bigint") return `"${value.toString()}n"`;
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function roundRational(value: Rational): bigint {
  const sign = value.numerator < 0n ? -1n : 1n;
  const numerator = abs(value.numerator);
  const quotient = numerator / value.denominator;
  const remainder = numerator % value.denominator;
  const rounded = remainder * 2n >= value.denominator ? quotient + 1n : quotient;
  return sign * rounded;
}

function mapSourceToFrame(
  clip: TimelineOffsetMapClip,
  sourceUs: bigint,
  fps: Rational,
): bigint {
  const delta = sourceUs - BigInt(clip.src_in_us);
  const speed = rational(clip.speed.numerator, clip.speed.denominator);
  const frames = rational(
    delta * fps.numerator * speed.denominator,
    MICROSECONDS * fps.denominator * speed.numerator,
  );
  const raw = BigInt(clip.timeline_in_frame) + roundRational(frames);
  const start = BigInt(clip.timeline_in_frame);
  const end = start + BigInt(clip.timeline_duration_frames);
  return raw < start ? start : raw > end ? end : raw;
}

function clipsForSource(map: TimelineOffsetMap, assetId: string, segmentId?: string): TimelineOffsetMapClip[] {
  const matching = map.clips.filter((clip) =>
    clip.asset_id === assetId && (segmentId === undefined || clip.segment_id === segmentId),
  );
  const a1 = matching.filter((clip) => clip.track_id === "A1");
  const legacyDialogue = matching.filter((clip) =>
    clip.track_kind === "audio" || clip.role === "dialogue" || clip.role === "A1",
  );
  const preferred = a1.length > 0 ? a1 : legacyDialogue.length > 0 ? legacyDialogue : matching;
  return [...preferred].sort((left, right) =>
    BigInt(left.timeline_in_frame) < BigInt(right.timeline_in_frame) ? -1 : 1,
  );
}

export function buildTimelineOffsetMap(input: {
  fps_num: IntegerLike;
  fps_den?: IntegerLike;
  clips: TimelineOffsetClipInput[];
}): TimelineOffsetMap {
  const fps = rational(input.fps_num, input.fps_den ?? 1);
  const clips = input.clips.map((clip) => {
    const srcIn = toBigInt(clip.src_in_us, `${clip.clip_id}.src_in_us`);
    const srcOut = toBigInt(clip.src_out_us, `${clip.clip_id}.src_out_us`);
    const timelineIn = toBigInt(clip.timeline_in_frame, `${clip.clip_id}.timeline_in_frame`);
    const duration = toBigInt(clip.timeline_duration_frames, `${clip.clip_id}.timeline_duration_frames`);
    if (srcOut <= srcIn || duration <= 0n) throw new Error(`${clip.clip_id} has an invalid source or timeline range`);
    return {
      clip_id: clip.clip_id,
      asset_id: clip.asset_id,
      ...(clip.segment_id === undefined ? {} : { segment_id: clip.segment_id }),
      src_in_us: srcIn.toString(),
      src_out_us: srcOut.toString(),
      timeline_in_frame: timelineIn.toString(),
      timeline_duration_frames: duration.toString(),
      speed: rationalToJSON(rationalFrom(clip.speed)),
      ...(clip.track_id === undefined ? {} : { track_id: clip.track_id }),
      ...(clip.track_kind === undefined ? {} : { track_kind: clip.track_kind }),
      ...(clip.role === undefined ? {} : { role: clip.role }),
    } satisfies TimelineOffsetMapClip;
  }).sort((left, right) => left.clip_id.localeCompare(right.clip_id));
  const dialogueAuthority: TimelineOffsetMap["dialogue_authority"] = clips.some((clip) => clip.track_id === "A1") ? "A1" : "legacy-role";
  const payload: Omit<TimelineOffsetMap, "fingerprint"> = { version: "timeline-offset-map/v1", fps: rationalToJSON(fps), clips, dialogue_authority: dialogueAuthority };
  const fingerprint = `sha256:${createHash("sha256").update(canonical(payload)).digest("hex")}`;
  return { ...payload, fingerprint };
}

export function buildTimelineOffsetMapFromTimeline(timeline: {
  sequence?: { fps_num?: number; fps_den?: number };
  tracks?: Record<string, Array<{ track_id: string; kind?: TimelineOffsetClipInput["track_kind"]; clips?: unknown[] }>>;
}): TimelineOffsetMap {
  const clips: TimelineOffsetClipInput[] = [];
  for (const [kind, tracks] of Object.entries(timeline.tracks ?? {})) {
    for (const track of tracks ?? []) {
      for (const raw of track.clips ?? []) {
        const clip = raw as Record<string, unknown>;
        const number = (key: string, fallback = 0): number =>
          typeof clip[key] === "number" ? clip[key] as number : fallback;
        const metadata = clip.metadata && typeof clip.metadata === "object"
          ? clip.metadata as Record<string, unknown> : {};
        clips.push({
          clip_id: String(clip.clip_id ?? `${track.track_id}-${clips.length}`),
          asset_id: String(clip.asset_id ?? ""),
          segment_id: typeof clip.segment_id === "string" ? clip.segment_id : undefined,
          src_in_us: number("src_in_us"),
          src_out_us: number("src_out_us", number("src_in_us") + 1),
          timeline_in_frame: number("timeline_in_frame"),
          timeline_duration_frames: number("timeline_duration_frames", 1),
          speed: clip.speed as RationalLike ?? metadata.speed as RationalLike ?? metadata.playback_rate as RationalLike,
          track_id: track.track_id,
          track_kind: (kind === "video" || kind === "audio" || kind === "overlay" || kind === "caption")
            ? kind : undefined,
          role: typeof clip.role === "string" ? clip.role : undefined,
        });
      }
    }
  }
  return buildTimelineOffsetMap({
    fps_num: timeline.sequence?.fps_num ?? 24,
    fps_den: timeline.sequence?.fps_den ?? 1,
    clips,
  });
}

export function projectSourceRange(
  map: TimelineOffsetMap,
  input: { asset_id: string; segment_id?: string; source_start_us: IntegerLike; source_end_us: IntegerLike; source_word_refs?: SourceWordRef[] },
): OffsetProjection {
  const start = toBigInt(input.source_start_us, "source_start_us");
  const end = toBigInt(input.source_end_us, "source_end_us");
  if (end <= start) {
    return { timeline_in_frame: 0, timeline_duration_frames: 1, segments: [], clip_map_refs: [], occurrence_refs: [], source_word_refs: input.source_word_refs ?? [], authority: "fallback", confidence: 0, status: "invalid", fallback_reason: "source range is empty or reversed" };
  }
  const fps = rational(map.fps.numerator, map.fps.denominator);
  const clips = clipsForSource(map, input.asset_id, input.segment_id);
  const segments: OffsetProjectionSegment[] = [];
  for (const clip of clips) {
    const clipStart = BigInt(clip.src_in_us);
    const clipEnd = BigInt(clip.src_out_us);
    const overlapStart = start > clipStart ? start : clipStart;
    const overlapEnd = end < clipEnd ? end : clipEnd;
    if (overlapEnd <= overlapStart) continue;
    const timelineStart = mapSourceToFrame(clip, overlapStart, fps);
    const timelineEnd = mapSourceToFrame(clip, overlapEnd, fps);
    segments.push({
      occurrence_id: clip.clip_id,
      clip_id: clip.clip_id,
      source_start_us: Number(overlapStart),
      source_end_us: Number(overlapEnd),
      timeline_start_frame: Number(timelineStart),
      timeline_end_frame: Number(timelineEnd),
    });
  }
  if (segments.length === 0) {
    return { timeline_in_frame: 0, timeline_duration_frames: 1, segments, clip_map_refs: [], occurrence_refs: [], source_word_refs: input.source_word_refs ?? [], authority: "fallback", confidence: 0.25, status: "fallback", fallback_reason: "source range is not present in the final timeline" };
  }
  const first = segments[0];
  const last = segments[segments.length - 1];
  const invalidSegment = segments.find((segment) => segment.timeline_end_frame <= segment.timeline_start_frame);
  const hasGap = segments.some((segment, index) => index > 0 && segment.timeline_start_frame > segments[index - 1].timeline_end_frame);
  const occurrenceRefs = [...new Set(segments.map((segment) => segment.occurrence_id))];
  const crossesOccurrence = segments.some((segment, index) => index > 0 && segment.occurrence_id !== segments[index - 1].occurrence_id);
  const authority = clips.some((clip) => clip.track_id === "A1") ? "A1" : "legacy-role";
  if (invalidSegment || hasGap || crossesOccurrence) {
    const fallbackReason = invalidSegment
      ? "canonical timeline clamp produced a non-positive frame range"
      : crossesOccurrence && hasGap
        ? "source range spans separated timeline occurrences; distinct occurrences were not concatenated"
        : crossesOccurrence
        ? "source range spans distinct timeline occurrences; projection was not concatenated"
        : "source range spans separated timeline occurrences; projection was not concatenated";
    return {
      timeline_in_frame: invalidSegment?.timeline_start_frame ?? first.timeline_start_frame,
      timeline_duration_frames: invalidSegment ? 0 : Math.max(1, first.timeline_end_frame - first.timeline_start_frame),
      segments,
      clip_map_refs: segments.map((segment) => segment.clip_id),
      occurrence_refs: occurrenceRefs,
      source_word_refs: input.source_word_refs ?? [],
      authority,
      confidence: 0,
      status: "blocked",
      fallback_reason: fallbackReason,
    };
  }
  return {
    timeline_in_frame: first.timeline_start_frame,
    timeline_duration_frames: Math.max(1, last.timeline_end_frame - first.timeline_start_frame),
    segments,
    clip_map_refs: segments.map((segment) => segment.clip_id),
    occurrence_refs: occurrenceRefs,
    source_word_refs: input.source_word_refs ?? [],
    authority,
    confidence: 1,
    status: "exact",
  };
}

export function offsetMapFingerprint(map: TimelineOffsetMap): string { return map.fingerprint; }
