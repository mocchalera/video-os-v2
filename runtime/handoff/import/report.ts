import type {
  BridgeFingerprint,
  NleCapabilityProfile,
} from "../bridge-contract.js";
import type { HandoffManifest } from "../export.js";
import { detectLossyItems } from "./loss-classifier.js";
import type { OneToManyResult } from "./normalization.js";
import type {
  ClipMapping,
  NleSessionObserved,
  NormalizedClip,
  RoundtripImportReport,
} from "./index.js";

export function buildImportReport(
  manifest: HandoffManifest,
  profile: NleCapabilityProfile,
  bridgeFingerprint: BridgeFingerprint,
  exportedClips: NormalizedClip[],
  mappings: ClipMapping[],
  oneToMany: OneToManyResult,
  unmapped: NormalizedClip[],
  reviewRequired: boolean,
  status: "success" | "partial" | "failed",
  importedAt: string,
  nleSession?: NleSessionObserved,
): RoundtripImportReport {
  const exactMatches = oneToMany.oneToOne.filter((mapping) => mapping.confidence === "exact").length;
  const fallbackMatches = oneToMany.oneToOne.filter((mapping) => mapping.confidence === "fallback").length;
  const provisionalMatches = oneToMany.oneToOne.filter((mapping) => mapping.confidence === "provisional").length;
  const lossDetection = detectLossyItems(
    profile,
    mappings,
    unmapped,
    oneToMany.splitEntries,
    oneToMany.duplicateEntries,
    oneToMany.ambiguousEntries,
  );

  const report: RoundtripImportReport = {
    version: 1,
    project_id: manifest.project_id,
    handoff_id: manifest.handoff_id,
    imported_at: importedAt,
    capability_profile_id: profile.profile_id,
    status,
    base_timeline: {
      version: manifest.base_timeline.version,
      hash: manifest.base_timeline.hash,
    },
    bridge: bridgeFingerprint,
    mapping_summary: {
      exported_clip_count: exportedClips.length,
      imported_clip_count: mappings.length + unmapped.length,
      exact_matches: exactMatches,
      fallback_matches: fallbackMatches,
      provisional_matches: provisionalMatches,
      split_items: oneToMany.splitEntries.length,
      duplicate_id_items: oneToMany.duplicateEntries.length,
      ambiguous_one_to_many_items: oneToMany.ambiguousEntries.length,
      unmapped_items: unmapped.length,
    },
    notes: ["No canonical artifact was mutated."],
  };

  if (
    oneToMany.splitEntries.length > 0 ||
    oneToMany.duplicateEntries.length > 0 ||
    oneToMany.ambiguousEntries.length > 0
  ) {
    report.one_to_many_items = {};
    if (oneToMany.splitEntries.length > 0) {
      report.one_to_many_items.split_entries = oneToMany.splitEntries;
    }
    if (oneToMany.duplicateEntries.length > 0) {
      report.one_to_many_items.duplicate_entries = oneToMany.duplicateEntries;
    }
    if (oneToMany.ambiguousEntries.length > 0) {
      report.one_to_many_items.ambiguous_entries = oneToMany.ambiguousEntries;
    }
  }

  if (
    lossDetection.lossyItems.length > 0 ||
    lossDetection.unmappedItems.length > 0 ||
    lossDetection.unsupportedItems.length > 0
  ) {
    report.loss_summary = {
      review_required: reviewRequired,
    };
    if (lossDetection.lossyItems.length > 0) {
      report.loss_summary.lossy_items = lossDetection.lossyItems;
    }
    if (lossDetection.unmappedItems.length > 0) {
      report.loss_summary.unmapped_items = lossDetection.unmappedItems;
    }
    if (lossDetection.unsupportedItems.length > 0) {
      report.loss_summary.unsupported_items = lossDetection.unsupportedItems;
    }
  }

  if (nleSession) {
    report.nle_session = nleSession;
  }

  return report;
}
