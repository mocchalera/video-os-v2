import type {
  AmbiguousEntry,
  ClipMapping,
  DuplicateEntry,
  SplitEntry,
} from "./index.js";

export interface OneToManyResult {
  oneToOne: ClipMapping[];
  splitEntries: SplitEntry[];
  duplicateEntries: DuplicateEntry[];
  ambiguousEntries: AmbiguousEntry[];
}

export function normalizeOneToMany(
  mappings: ClipMapping[],
): OneToManyResult {
  const groups = new Map<string, ClipMapping[]>();
  for (const mapping of mappings) {
    const key = mapping.exportedExchangeClipId;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(mapping);
  }

  const oneToOne: ClipMapping[] = [];
  const splitEntries: SplitEntry[] = [];
  const duplicateEntries: DuplicateEntry[] = [];
  const ambiguousEntries: AmbiguousEntry[] = [];

  for (const [parentId, group] of groups) {
    if (group.length === 1) {
      oneToOne.push(group[0]);
      continue;
    }

    const sorted = [...group].sort((a, b) => {
      const srcDiff = a.imported.src_in_us - b.imported.src_in_us;
      if (srcDiff !== 0) return srcDiff;
      return a.imported.timeline_in_frame - b.imported.timeline_in_frame;
    });

    const classification = classifyOneToMany(sorted);
    if (classification === "split") {
      splitEntries.push({
        parent_exchange_clip_id: parentId,
        child_ids: sorted.map((_, index) => `${parentId}#S${String(index + 1).padStart(2, "0")}`),
        review_required: true,
      });
      continue;
    }

    if (classification === "duplicate") {
      duplicateEntries.push({
        parent_exchange_clip_id: parentId,
        retained_exchange_clip_id: parentId,
        copy_ids: sorted.slice(1).map((_, index) => `${parentId}#D${String(index + 1).padStart(2, "0")}`),
        provenance: { basis: "duplicate_metadata_collision" },
        review_required: true,
      });
      continue;
    }

    ambiguousEntries.push({
      parent_exchange_clip_id: parentId,
      candidates: sorted.map((_, index) => `${parentId}#A${String(index + 1).padStart(2, "0")}`),
      reason: "Cannot deterministically distinguish split from duplicate",
      review_required: true,
    });
  }

  return {
    oneToOne,
    splitEntries,
    duplicateEntries,
    ambiguousEntries,
  };
}

export function classifyOneToMany(
  sorted: ClipMapping[],
): "split" | "duplicate" | "ambiguous" {
  let hasOverlap = false;
  let hasNonOverlap = false;

  for (let i = 0; i < sorted.length - 1; i++) {
    const current = sorted[i].imported;
    const next = sorted[i + 1].imported;
    if (current.src_out_us > next.src_in_us) {
      hasOverlap = true;
    } else {
      hasNonOverlap = true;
    }
  }

  if (hasOverlap && hasNonOverlap) return "ambiguous";
  if (hasOverlap) return "duplicate";
  if (hasNonOverlap) return "split";

  if (sorted.length === 2) {
    return sorted[0].imported.src_out_us > sorted[1].imported.src_in_us
      ? "duplicate"
      : "split";
  }

  return "ambiguous";
}
