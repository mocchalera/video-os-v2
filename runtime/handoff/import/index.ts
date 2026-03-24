import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  evaluateFingerprintMismatch,
  type BridgeFingerprint,
  type NleCapabilityProfile,
} from "../bridge-contract.js";
import {
  loadCapabilityProfile,
  sha256,
  type HandoffManifest,
} from "../export.js";
import { determineImportStatus, detectLossyItems, evaluateGate9 } from "./loss-classifier.js";
import { mapClips } from "./mapping.js";
import { normalizeOneToMany, type OneToManyResult } from "./normalization.js";
import { normalizeOtioViaBridge } from "./parser.js";
import { buildImportReport } from "./report.js";

export interface HandoffImportInput {
  manifestPath: string;
  importedOtioPath: string;
  exportedOtioPath?: string;
  profilePath: string;
  outputDir: string;
  pythonPath?: string;
  nleSessionObserved?: NleSessionObserved;
}

export interface NleSessionObserved {
  vendor?: string;
  product?: string;
  observed_version?: string;
  import_options_snapshot?: Record<string, unknown>;
  export_options_snapshot?: Record<string, unknown>;
}

export interface NormalizedClip {
  exchange_clip_id: string;
  clip_id: string;
  track_id: string;
  asset_id: string;
  segment_id: string;
  src_in_us: number;
  src_out_us: number;
  timeline_in_frame: number;
  timeline_duration_frames: number;
  name?: string;
  enabled?: boolean;
  metadata_lost?: boolean;
  track_kind?: string;
  vendor_metadata_keys?: string[];
  track_vendor_metadata_keys?: string[];
  unknown_property_keys?: string[];
  track_unknown_property_keys?: string[];
  effect_names?: string[];
}

export type MappingConfidence = "exact" | "fallback" | "provisional";

export interface ClipMapping {
  imported: NormalizedClip;
  exportedExchangeClipId: string;
  confidence: MappingConfidence;
}

export interface SplitEntry {
  parent_exchange_clip_id: string;
  child_ids: string[];
  review_required: boolean;
}

export interface DuplicateEntry {
  parent_exchange_clip_id: string;
  retained_exchange_clip_id: string;
  copy_ids: string[];
  provenance: { basis: string };
  review_required: boolean;
}

export interface AmbiguousEntry {
  parent_exchange_clip_id: string;
  candidates: string[];
  reason: string;
  review_required: boolean;
}

export interface LossItem {
  classification: string;
  item_ref: string;
  reason: string;
}

export interface RoundtripImportReport {
  version: 1;
  project_id: string;
  handoff_id: string;
  imported_at: string;
  capability_profile_id: string;
  status: "success" | "partial" | "failed";
  base_timeline: {
    version: string;
    hash: string;
  };
  bridge: BridgeFingerprint;
  nle_session?: NleSessionObserved;
  mapping_summary: {
    exported_clip_count: number;
    imported_clip_count: number;
    exact_matches: number;
    fallback_matches: number;
    provisional_matches: number;
    split_items: number;
    duplicate_id_items: number;
    ambiguous_one_to_many_items: number;
    unmapped_items: number;
  };
  one_to_many_items?: {
    split_entries?: SplitEntry[];
    duplicate_entries?: DuplicateEntry[];
    ambiguous_entries?: AmbiguousEntry[];
  };
  loss_summary?: {
    review_required: boolean;
    lossy_items?: LossItem[];
    unmapped_items?: LossItem[];
    unsupported_items?: LossItem[];
  };
  notes?: string[];
}

export interface HandoffImportResult {
  report: RoundtripImportReport;
  reportPath: string;
  reviewRequired: boolean;
  bridgeFingerprint: BridgeFingerprint;
}

export interface ImportError {
  code:
    | "MANIFEST_NOT_FOUND"
    | "IMPORTED_OTIO_NOT_FOUND"
    | "PROFILE_NOT_FOUND"
    | "BASE_HASH_MISMATCH"
    | "BRIDGE_FAILED"
    | "BRIDGE_FINGERPRINT_MISMATCH";
  message: string;
  details?: unknown;
}

function resolveManifestArtifactPath(
  manifestPath: string,
  artifactPath: string,
): string {
  if (path.isAbsolute(artifactPath)) {
    return artifactPath;
  }

  let cursor = path.dirname(manifestPath);
  while (true) {
    const candidate = path.resolve(cursor, artifactPath);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      break;
    }
    cursor = parent;
  }

  return path.resolve(path.dirname(manifestPath), artifactPath);
}

function verifyBaseTimelineHash(
  manifestPath: string,
  manifest: HandoffManifest,
): { ok: true; path: string; actualHash: string } | { ok: false; error: ImportError } {
  const resolvedPath = resolveManifestArtifactPath(manifestPath, manifest.base_timeline.path);
  if (!fs.existsSync(resolvedPath)) {
    return {
      ok: false,
      error: {
        code: "BASE_HASH_MISMATCH",
        message: `Base timeline not found for hash verification: ${resolvedPath}`,
        details: {
          expectedHash: manifest.base_timeline.hash,
          actualHash: null,
          baseTimelinePath: resolvedPath,
        },
      },
    };
  }

  const actualHash = sha256(fs.readFileSync(resolvedPath, "utf-8"));
  if (actualHash !== manifest.base_timeline.hash) {
    return {
      ok: false,
      error: {
        code: "BASE_HASH_MISMATCH",
        message: "Base timeline hash mismatch. Import must target the original exported base timeline.",
        details: {
          expectedHash: manifest.base_timeline.hash,
          actualHash,
          baseTimelinePath: resolvedPath,
        },
      },
    };
  }

  return {
    ok: true,
    path: resolvedPath,
    actualHash,
  };
}

export function executeHandoffImport(
  input: HandoffImportInput,
): HandoffImportResult | { error: ImportError } {
  if (!fs.existsSync(input.manifestPath)) {
    return {
      error: {
        code: "MANIFEST_NOT_FOUND",
        message: `Handoff manifest not found: ${input.manifestPath}`,
      },
    };
  }
  const manifest = parseYaml(fs.readFileSync(input.manifestPath, "utf-8")) as HandoffManifest;

  if (!fs.existsSync(input.importedOtioPath)) {
    return {
      error: {
        code: "IMPORTED_OTIO_NOT_FOUND",
        message: `Imported OTIO not found: ${input.importedOtioPath}`,
      },
    };
  }

  if (!fs.existsSync(input.profilePath)) {
    return {
      error: {
        code: "PROFILE_NOT_FOUND",
        message: `Capability profile not found: ${input.profilePath}`,
      },
    };
  }
  const profile = loadCapabilityProfile(input.profilePath);

  const baseHashCheck = verifyBaseTimelineHash(input.manifestPath, manifest);
  if (!baseHashCheck.ok) {
    return { error: baseHashCheck.error };
  }

  fs.mkdirSync(input.outputDir, { recursive: true });
  const normalizedDir = path.join(input.outputDir, "normalized");
  fs.mkdirSync(normalizedDir, { recursive: true });

  const bridgeScriptPath = path.join(
    path.dirname(new URL(import.meta.url).pathname),
    "../otio-bridge.py",
  );

  const importedNormPath = path.join(normalizedDir, "imported_otio.json");
  const importResult = normalizeOtioViaBridge(
    input.importedOtioPath,
    importedNormPath,
    bridgeScriptPath,
    input.pythonPath,
    input.outputDir,
  );

  if (!importResult.ok) {
    return {
      error: {
        code: "BRIDGE_FAILED",
        message: importResult.error.message,
        details: importResult.error.details,
      },
    };
  }

  if (
    (importResult.document.project_id &&
      importResult.document.project_id !== manifest.project_id) ||
    (importResult.document.handoff_id &&
      importResult.document.handoff_id !== manifest.handoff_id) ||
    (importResult.document.timeline_version &&
      importResult.document.timeline_version !== manifest.base_timeline.version)
  ) {
    return {
      error: {
        code: "BASE_HASH_MISMATCH",
        message: "Imported OTIO metadata does not match the manifest base timeline session.",
        details: {
          expected: {
            project_id: manifest.project_id,
            handoff_id: manifest.handoff_id,
            timeline_version: manifest.base_timeline.version,
            base_hash: manifest.base_timeline.hash,
          },
          actual: {
            project_id: importResult.document.project_id,
            handoff_id: importResult.document.handoff_id,
            timeline_version: importResult.document.timeline_version,
          },
        },
      },
    };
  }

  let exportedClips: NormalizedClip[] = [];
  if (input.exportedOtioPath && fs.existsSync(input.exportedOtioPath)) {
    const exportedNormPath = path.join(normalizedDir, "exported_otio.json");
    const exportResult = normalizeOtioViaBridge(
      input.exportedOtioPath,
      exportedNormPath,
      bridgeScriptPath,
      input.pythonPath,
      input.outputDir,
    );
    if (!exportResult.ok) {
      return {
        error: {
          code: "BRIDGE_FAILED",
          message: exportResult.error.message,
          details: exportResult.error.details,
        },
      };
    }
    exportedClips = exportResult.document.clips;
  }

  const fingerprintSeverity = evaluateFingerprintMismatch(
    manifest.bridge,
    importResult.fingerprint,
  );
  if (fingerprintSeverity === "failed") {
    return {
      error: {
        code: "BRIDGE_FINGERPRINT_MISMATCH",
        message: "Bridge fingerprint mismatch: bridge version or OTIO major/minor differs",
        details: {
          expected: manifest.bridge,
          actual: importResult.fingerprint,
        },
      },
    };
  }

  const { mapped, unmapped } = mapClips(
    exportedClips,
    importResult.document.clips,
    manifest.project_id,
    manifest.base_timeline.version,
  );
  const oneToMany = normalizeOneToMany(mapped);
  const lossDetection = detectLossyItems(
    profile,
    mapped,
    unmapped,
    oneToMany.splitEntries,
    oneToMany.duplicateEntries,
    oneToMany.ambiguousEntries,
  );
  const reviewRequired = evaluateGate9(
    oneToMany.oneToOne,
    unmapped,
    oneToMany.splitEntries,
    oneToMany.duplicateEntries,
    oneToMany.ambiguousEntries,
    profile,
    {
      droppedStableMetadataCount: lossDetection.droppedStableMetadataCount,
      lossyCount: lossDetection.lossyItems.length,
      unsupportedCount: lossDetection.unsupportedItems.length,
    },
  );
  const importedAt = new Date().toISOString();
  const status = determineImportStatus(
    reviewRequired,
    unmapped.length,
    importResult.document.clips.length,
    fingerprintSeverity,
  );
  const report = buildImportReport(
    manifest,
    profile,
    importResult.fingerprint,
    exportedClips,
    mapped,
    oneToMany,
    unmapped,
    reviewRequired,
    status,
    importedAt,
    input.nleSessionObserved,
  );

  const reportPath = path.join(input.outputDir, "roundtrip_import_report.yaml");
  fs.writeFileSync(reportPath, stringifyYaml(report), "utf-8");

  return {
    report,
    reportPath,
    reviewRequired,
    bridgeFingerprint: importResult.fingerprint,
  };
}

export function executeOfflineImport(opts: {
  manifest: HandoffManifest;
  profile: NleCapabilityProfile;
  exportedClips: NormalizedClip[];
  importedClips: NormalizedClip[];
  bridgeFingerprint: BridgeFingerprint;
  nleSession?: NleSessionObserved;
  importedAt?: string;
}): {
  report: RoundtripImportReport;
  reviewRequired: boolean;
} {
  const { manifest, profile, exportedClips, importedClips, bridgeFingerprint } = opts;
  const importedAt = opts.importedAt ?? new Date().toISOString();
  const { mapped, unmapped } = mapClips(
    exportedClips,
    importedClips,
    manifest.project_id,
    manifest.base_timeline.version,
  );
  const oneToMany = normalizeOneToMany(mapped);
  const lossDetection = detectLossyItems(
    profile,
    mapped,
    unmapped,
    oneToMany.splitEntries,
    oneToMany.duplicateEntries,
    oneToMany.ambiguousEntries,
  );
  const reviewRequired = evaluateGate9(
    oneToMany.oneToOne,
    unmapped,
    oneToMany.splitEntries,
    oneToMany.duplicateEntries,
    oneToMany.ambiguousEntries,
    profile,
    {
      droppedStableMetadataCount: lossDetection.droppedStableMetadataCount,
      lossyCount: lossDetection.lossyItems.length,
      unsupportedCount: lossDetection.unsupportedItems.length,
    },
  );
  const fingerprintSeverity = evaluateFingerprintMismatch(manifest.bridge, bridgeFingerprint);
  const status = determineImportStatus(
    reviewRequired,
    unmapped.length,
    importedClips.length,
    fingerprintSeverity,
  );
  const report = buildImportReport(
    manifest,
    profile,
    bridgeFingerprint,
    exportedClips,
    mapped,
    oneToMany,
    unmapped,
    reviewRequired,
    status,
    importedAt,
    opts.nleSession,
  );

  return { report, reviewRequired };
}

export type { Gate9EvidenceCounts } from "./loss-classifier.js";
export type { OneToManyResult } from "./normalization.js";
export {
  buildImportReport,
  classifyOneToMany,
  detectLossyItems,
  determineImportStatus,
  evaluateGate9,
  mapClips,
  normalizeOneToMany,
  normalizeOtioViaBridge,
} from "./index-reexports.js";
