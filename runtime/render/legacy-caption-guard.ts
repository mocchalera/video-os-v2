import type { TimelineIR } from "../compiler/types.js";

export function legacyCaptionClipIds(timeline: TimelineIR): string[] {
  return (timeline.tracks?.video ?? [])
    .flatMap((track) => track.clips)
    .filter((clip) => (clip.captions?.length ?? 0) > 0)
    .map((clip) => clip.clip_id)
    .sort((left, right) => left.localeCompare(right, "en"));
}

export function assertNoLegacyClipCaptionsForPackage(timeline: TimelineIR): void {
  const clipIds = legacyCaptionClipIds(timeline);
  if (clipIds.length > 0) {
    throw new Error(
      `legacy_clip_captions_forbidden_in_package: clip_ids=${clipIds.join(",")}`,
    );
  }
}
