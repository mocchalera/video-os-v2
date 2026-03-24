import type { NleCapabilityProfile } from "../bridge-contract.js";
import type {
  AmbiguousEntry,
  ClipMapping,
  DuplicateEntry,
  LossItem,
  NormalizedClip,
  SplitEntry,
} from "./index.js";

export interface Gate9EvidenceCounts {
  droppedStableMetadataCount?: number;
  lossyCount?: number;
  unsupportedCount?: number;
}

const SURFACE_TO_CLASSIFICATION: Record<string, string> = {
  color_finish: "color_finish",
  fusion_effect: "plugin_effect",
  fairlight_advanced_audio: "advanced_audio_finish",
  plugin_effect: "plugin_effect",
  advanced_audio_finish: "advanced_audio_finish",
  complex_title: "complex_title",
  speed_change: "speed_change",
  nested_sequence: "nested_sequence",
};

const COLOR_EVIDENCE_PATTERN = /(color|grade|lut|node|resolve)/i;
const AUDIO_EVIDENCE_PATTERN = /(audio|fairlight|eq|compress|limiter|gain|bus|mix|dynamics)/i;

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

function clipRef(
  clip: NormalizedClip,
  index: number,
  preferredExchangeClipId?: string,
): string {
  if (preferredExchangeClipId) {
    return `clip:${preferredExchangeClipId}`;
  }
  if (clip.exchange_clip_id) {
    return `clip:${clip.exchange_clip_id}`;
  }
  return `clip@track=${clip.track_id},index=${index}`;
}

function pushLossItem(
  target: LossItem[],
  seen: Set<string>,
  item: LossItem,
): void {
  const key = `${item.classification}:${item.item_ref}`;
  if (seen.has(key)) return;
  seen.add(key);
  target.push(item);
}

function addSurfaceEvidence(
  profile: NleCapabilityProfile,
  surfaceName: string,
  itemRef: string,
  reason: string,
  lossyItems: LossItem[],
  unsupportedItems: LossItem[],
  lossySeen: Set<string>,
  unsupportedSeen: Set<string>,
): void {
  const classification = SURFACE_TO_CLASSIFICATION[surfaceName] ?? "unknown_vendor_extension";
  const surfaceMode = profile.surfaces[surfaceName]?.mode;
  const item: LossItem = {
    classification,
    item_ref: itemRef,
    reason,
  };

  if (surfaceMode === "lossy") {
    pushLossItem(lossyItems, lossySeen, item);
    return;
  }

  pushLossItem(unsupportedItems, unsupportedSeen, {
    ...item,
    reason: `${reason}; outside editable surface allowlist`,
  });
}

export function detectLossyItems(
  profile: NleCapabilityProfile,
  mappings: ClipMapping[],
  unmapped: NormalizedClip[],
  splitEntries: SplitEntry[],
  duplicateEntries: DuplicateEntry[],
  ambiguousEntries: AmbiguousEntry[],
): {
  lossyItems: LossItem[];
  unmappedItems: LossItem[];
  unsupportedItems: LossItem[];
  droppedStableMetadataCount: number;
} {
  const lossyItems: LossItem[] = [];
  const unmappedItems: LossItem[] = [];
  const unsupportedItems: LossItem[] = [];
  const lossySeen = new Set<string>();
  const unmappedSeen = new Set<string>();
  const unsupportedSeen = new Set<string>();
  let droppedStableMetadataCount = 0;

  const clipsWithEvidence = [
    ...mappings.map((mapping, index) => ({
      clip: mapping.imported,
      index,
      preferredExchangeClipId: mapping.exportedExchangeClipId,
    })),
    ...unmapped.map((clip, index) => ({
      clip,
      index,
      preferredExchangeClipId: undefined,
    })),
  ];

  for (const { clip, index, preferredExchangeClipId } of clipsWithEvidence) {
    const itemRef = clipRef(clip, index, preferredExchangeClipId);

    if (clip.metadata_lost) {
      droppedStableMetadataCount += 1;
      pushLossItem(unmappedItems, unmappedSeen, {
        classification: "missing_stable_id",
        item_ref: itemRef,
        reason: "imported clip dropped exchange_clip_id",
      });
    }

    const effectNames = normalizeStringArray(clip.effect_names);
    if (effectNames.length > 0) {
      addSurfaceEvidence(
        profile,
        profile.surfaces.fusion_effect ? "fusion_effect" : "plugin_effect",
        itemRef,
        `imported clip carries effect evidence (${effectNames.join(", ")})`,
        lossyItems,
        unsupportedItems,
        lossySeen,
        unsupportedSeen,
      );
    }

    const metadataEvidence = [
      ...normalizeStringArray(clip.vendor_metadata_keys),
      ...normalizeStringArray(clip.track_vendor_metadata_keys),
      ...normalizeStringArray(clip.unknown_property_keys),
      ...normalizeStringArray(clip.track_unknown_property_keys),
    ];

    if (metadataEvidence.length === 0) continue;

    const metadataSummary = metadataEvidence.join(", ");
    if (COLOR_EVIDENCE_PATTERN.test(metadataSummary)) {
      addSurfaceEvidence(
        profile,
        "color_finish",
        itemRef,
        `imported clip carries color-finish metadata evidence (${metadataSummary})`,
        lossyItems,
        unsupportedItems,
        lossySeen,
        unsupportedSeen,
      );
      continue;
    }

    if (clip.track_kind === "audio" || AUDIO_EVIDENCE_PATTERN.test(metadataSummary)) {
      addSurfaceEvidence(
        profile,
        "fairlight_advanced_audio",
        itemRef,
        `imported clip carries advanced-audio metadata evidence (${metadataSummary})`,
        lossyItems,
        unsupportedItems,
        lossySeen,
        unsupportedSeen,
      );
      continue;
    }

    pushLossItem(unsupportedItems, unsupportedSeen, {
      classification: "unknown_vendor_extension",
      item_ref: itemRef,
      reason: `vendor-specific metadata only; meaning cannot be resolved deterministically (${metadataSummary})`,
    });
  }

  for (let i = 0; i < unmapped.length; i++) {
    const clip = unmapped[i];
    pushLossItem(unmappedItems, unmappedSeen, {
      classification: "missing_stable_id",
      item_ref: clipRef(clip, i),
      reason: clip.metadata_lost
        ? "imported clip dropped exchange_clip_id"
        : "imported clip has no matching exchange_clip_id in exported base",
    });
  }

  for (const entry of splitEntries) {
    pushLossItem(unmappedItems, unmappedSeen, {
      classification: "split_clip",
      item_ref: `clip:${entry.parent_exchange_clip_id}`,
      reason: "one-to-many stable ID cannot be auto-reduced to a single canonical diff operation",
    });
  }

  for (const entry of duplicateEntries) {
    pushLossItem(unmappedItems, unmappedSeen, {
      classification: "duplicated_clip",
      item_ref: `clip:${entry.parent_exchange_clip_id}`,
      reason: "duplicate stable ID collision requires manual review",
    });
  }

  for (const entry of ambiguousEntries) {
    pushLossItem(unmappedItems, unmappedSeen, {
      classification: "ambiguous_one_to_many",
      item_ref: `clip:${entry.parent_exchange_clip_id}`,
      reason: entry.reason,
    });
  }

  return {
    lossyItems,
    unmappedItems,
    unsupportedItems,
    droppedStableMetadataCount,
  };
}

export function evaluateGate9(
  mappings: ClipMapping[],
  unmapped: NormalizedClip[],
  splitEntries: SplitEntry[],
  duplicateEntries: DuplicateEntry[],
  ambiguousEntries: AmbiguousEntry[],
  profile: NleCapabilityProfile,
  evidence: Gate9EvidenceCounts = {},
): boolean {
  if (unmapped.length > 0) return true;

  if (mappings.some((mapping) => mapping.confidence === "provisional") &&
    profile.import_policy.provisional_mapping_requires_review) {
    return true;
  }

  if (
    (splitEntries.length > 0 ||
      duplicateEntries.length > 0 ||
      ambiguousEntries.length > 0) &&
    profile.import_policy.one_to_many_requires_review
  ) {
    return true;
  }

  if ((evidence.droppedStableMetadataCount ?? 0) > 0) return true;
  if ((evidence.lossyCount ?? 0) > 0) return true;
  if ((evidence.unsupportedCount ?? 0) > 0) return true;

  return false;
}

export function determineImportStatus(
  reviewRequired: boolean,
  unmappedCount: number,
  importedCount: number,
  bridgeFingerprintSeverity: "ok" | "partial" | "failed",
): "success" | "partial" | "failed" {
  if (bridgeFingerprintSeverity === "failed") return "failed";
  if (importedCount === 0) return "failed";
  if (unmappedCount === importedCount) return "failed";
  if (reviewRequired) return "partial";
  if (bridgeFingerprintSeverity === "partial") return "partial";
  return "success";
}
