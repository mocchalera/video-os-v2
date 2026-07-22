import {
  packIssue,
  type BgmCatalog,
  type BgmTrackFilters,
  type CatalogTrack,
  type ResolvedBgmTrack,
} from "./pack-types.js";
import { inspectInstalledPacks, type PackRegistryOptions } from "./pack-registry.js";

export function buildBgmCatalog(options: PackRegistryOptions = {}): BgmCatalog {
  const registry = inspectInstalledPacks(options);
  const packs = registry.packs;
  const tracks: CatalogTrack[] = [];
  const warnings = [...registry.issues];
  for (const pack of packs) {
    if (!pack.verification.ok) continue;
    for (const track of pack.manifest.tracks) {
      const verified = pack.verification.verified_assets?.[track.track_id];
      if (!verified?.full_mix_path || !verified.preview_path) continue;
      tracks.push({
        pack_id: pack.manifest.pack_id,
        pack_version: pack.manifest.pack_version,
        pack_source: pack.source,
        manifest_hash: pack.manifest_hash,
        track,
        full_mix_path: verified.full_mix_path,
        preview_path: verified.preview_path,
      });
    }
  }
  tracks.sort((left, right) => left.track.track_id.localeCompare(right.track.track_id)
    || left.pack_id.localeCompare(right.pack_id));
  return { packs, tracks, warnings };
}

export function listTracks(
  filters: BgmTrackFilters = {},
  options: PackRegistryOptions = {},
): CatalogTrack[] {
  return buildBgmCatalog(options).tracks.filter((entry) => {
    const track = entry.track;
    return (!filters.family || track.family === filters.family)
      && (!filters.intensity || track.intensity === filters.intensity)
      && (!filters.vocal_presence || track.vocal_presence === filters.vocal_presence)
      && (!filters.use_case || track.use_cases.includes(filters.use_case));
  });
}

export function resolveTrack(
  trackId: string,
  pinnedHash?: string,
  options: PackRegistryOptions = {},
): ResolvedBgmTrack {
  const matches = listTracks({}, options).filter((entry) => entry.track.track_id === trackId);
  if (matches.length === 0) {
    return {
      ok: false,
      issues: [packIssue("BGM_TRACK_MISSING", "Selected BGM track is not available in a verified pack.", {
        affectedRef: trackId,
        suggestedAction: "Install the pinned pack or choose an available track.",
      })],
    };
  }
  if (!pinnedHash && matches.length > 1) {
    return {
      ok: false,
      issues: [packIssue("BGM_SELECTION_INCONCLUSIVE", "Track ID exists in multiple verified packs and requires a pinned content hash.", {
        affectedRef: trackId,
        recoverable: false,
        suggestedAction: "Pin the selected full-mix content hash before compiling or rendering.",
      })],
    };
  }
  const match = pinnedHash
    ? matches.find((entry) => entry.track.full_mix.content_hash === pinnedHash)
    : matches[0];
  if (!match) {
    return {
      ok: false,
      issues: [packIssue("BGM_TRACK_HASH_MISMATCH", "Installed track does not match the pinned content hash.", {
        affectedRef: trackId,
        recoverable: false,
        suggestedAction: "Install the exact pinned pack version before compiling or rendering.",
      })],
    };
  }
  return { ok: true, track: match, issues: [] };
}
