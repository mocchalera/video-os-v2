export function timelineEmbeddedMusicAssetIds(timeline: unknown): string[] {
  if (!timeline || typeof timeline !== "object") return [];
  const tracks = (timeline as {
    tracks?: { audio?: Array<{ track_id?: unknown; clips?: Array<{ asset_id?: unknown; role?: unknown }> }> };
  }).tracks?.audio;
  if (!Array.isArray(tracks)) return [];
  const assetIds = tracks.flatMap((track) =>
    (track.clips ?? []).flatMap((clip) => {
      const musicOwned = track.track_id === "A2" || clip.role === "bgm" || clip.role === "music";
      return musicOwned && typeof clip.asset_id === "string" ? [clip.asset_id] : [];
    })
  );
  return [...new Set(assetIds)].sort();
}
