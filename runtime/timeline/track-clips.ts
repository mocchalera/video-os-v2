export const TIMELINE_TRACK_LANES = ["video", "audio", "overlay", "caption"] as const;

export type TimelineTrackLane = typeof TIMELINE_TRACK_LANES[number];

type TimelineLike = {
  tracks?: Partial<Record<TimelineTrackLane, Array<{ clips?: unknown[] }>>>;
};

/** Enumerate every canonical and editor-authored timeline lane. */
export function enumerateTimelineClipValues(timeline: TimelineLike): unknown[] {
  const clips: unknown[] = [];
  for (const lane of TIMELINE_TRACK_LANES) {
    for (const track of timeline.tracks?.[lane] ?? []) {
      clips.push(...(track.clips ?? []));
    }
  }
  return clips;
}
