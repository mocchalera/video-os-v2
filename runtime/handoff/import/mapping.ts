import type {
  ClipMapping,
  MappingConfidence,
  NormalizedClip,
} from "./index.js";

export function mapClips(
  exportedClips: NormalizedClip[],
  importedClips: NormalizedClip[],
  projectId: string,
  timelineVersion: string,
): {
  mapped: ClipMapping[];
  unmapped: NormalizedClip[];
} {
  const mapped: ClipMapping[] = [];
  const unmapped: NormalizedClip[] = [];

  const exportedByExchangeId = new Map<string, NormalizedClip>();
  const exportedBySignature = new Map<string, NormalizedClip>();

  for (const clip of exportedClips) {
    if (clip.exchange_clip_id) {
      exportedByExchangeId.set(clip.exchange_clip_id, clip);
    }
    const signature = `${clip.asset_id}:${clip.src_in_us}:${clip.src_out_us}`;
    exportedBySignature.set(signature, clip);
  }

  for (const imported of importedClips) {
    const fallbackConfidence: MappingConfidence = imported.metadata_lost
      ? "provisional"
      : "fallback";

    if (imported.exchange_clip_id && exportedByExchangeId.has(imported.exchange_clip_id)) {
      mapped.push({
        imported,
        exportedExchangeClipId: imported.exchange_clip_id,
        confidence: "exact",
      });
      continue;
    }

    if (imported.clip_id) {
      const expectedExchangeId = `${projectId}:${timelineVersion}:${imported.clip_id}`;
      if (exportedByExchangeId.has(expectedExchangeId)) {
        mapped.push({
          imported,
          exportedExchangeClipId: expectedExchangeId,
          confidence: fallbackConfidence,
        });
        continue;
      }
    }

    if (imported.name) {
      let foundViaName = false;
      for (const [exchangeId, exported] of exportedByExchangeId) {
        if (imported.name.includes(exported.clip_id)) {
          mapped.push({
            imported,
            exportedExchangeClipId: exchangeId,
            confidence: fallbackConfidence,
          });
          foundViaName = true;
          break;
        }
      }
      if (foundViaName) continue;
    }

    const importedSig = `${imported.asset_id}:${imported.src_in_us}:${imported.src_out_us}`;
    const sigMatch = exportedBySignature.get(importedSig);
    if (sigMatch?.exchange_clip_id) {
      mapped.push({
        imported,
        exportedExchangeClipId: sigMatch.exchange_clip_id,
        confidence: "provisional",
      });
      continue;
    }

    unmapped.push(imported);
  }

  return { mapped, unmapped };
}
