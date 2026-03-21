/**
 * M3.5 Phase 3: Handoff Import Orchestrator
 *
 * Orchestrates the import of an edited OTIO file back into the video-os pipeline.
 * Responsibilities:
 * - Parse imported OTIO via Python bridge (normalize_otio / import_otio)
 * - base_timeline hash verification (correct export ↔ import session)
 * - Stable ID mapping (exchange_clip_id → original clip identity)
 * - Split normalization (1 clip → N clips with non-overlapping ranges)
 * - Duplicate normalization (1 clip → N copies)
 * - Unmapped edit detection (new clips without exchange_clip_id)
 * - Lossy item detection (capability profile based classification)
 * - roundtrip_import_report.yaml generation (schema-validated)
 * - Gate 9: unmapped_edits → review_required flag
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  BRIDGE_VERSION,
  evaluateFingerprintMismatch,
  type BridgeFingerprint,
  type BridgeRequest,
  type NleCapabilityProfile,
} from "./bridge-contract.js";
import {
  sha256,
  invokeBridge,
  loadCapabilityProfile,
  categorizeSurfaces,
  type HandoffManifest,
  type BridgeClipInput,
} from "./export.js";

// ── Types ──────────────────────────────────────────────────────────

export interface HandoffImportInput {
  /** Path to handoff_manifest.yaml */
  manifestPath: string;
  /** Path to the edited OTIO file from NLE */
  importedOtioPath: string;
  /** Path to the original exported OTIO (for readback comparison) */
  exportedOtioPath?: string;
  /** Path to NLE capability profile YAML */
  profilePath: string;
  /** Working directory for output */
  outputDir: string;
  /** Optional python binary path */
  pythonPath?: string;
  /** Optional NLE session observed info */
  nleSessionObserved?: NleSessionObserved;
}

export interface NleSessionObserved {
  vendor?: string;
  product?: string;
  observed_version?: string;
  import_options_snapshot?: Record<string, unknown>;
  export_options_snapshot?: Record<string, unknown>;
}

/** Normalized clip from bridge output */
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

/** Mapping confidence level */
export type MappingConfidence = "exact" | "fallback" | "provisional";

/** Individual clip mapping result */
export interface ClipMapping {
  imported: NormalizedClip;
  exportedExchangeClipId: string;
  confidence: MappingConfidence;
}

/** Split entry for one-to-many */
export interface SplitEntry {
  parent_exchange_clip_id: string;
  child_ids: string[];
  review_required: boolean;
}

/** Duplicate entry for one-to-many */
export interface DuplicateEntry {
  parent_exchange_clip_id: string;
  retained_exchange_clip_id: string;
  copy_ids: string[];
  provenance: { basis: string };
  review_required: boolean;
}

/** Ambiguous one-to-many entry */
export interface AmbiguousEntry {
  parent_exchange_clip_id: string;
  candidates: string[];
  reason: string;
  review_required: boolean;
}

/** Loss item */
export interface LossItem {
  classification: string;
  item_ref: string;
  reason: string;
}

/** Roundtrip import report (matches schema) */
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

interface NormalizedOtioDocument {
  project_id: string;
  handoff_id: string;
  timeline_version: string;
  clips: NormalizedClip[];
}

interface NormalizeOtioSuccess {
  ok: true;
  document: NormalizedOtioDocument;
  fingerprint: BridgeFingerprint;
  warnings: string[];
}

interface NormalizeOtioFailure {
  ok: false;
  error: {
    message: string;
    details: {
      request_context: {
        command: BridgeRequest["command"];
        input_path: string | null;
        output_path: string | null;
      };
      stderr: string;
      exit_code: number | null;
      timed_out: boolean;
      bridge?: BridgeFingerprint;
      warnings?: string[];
      bridge_error?: unknown;
    };
  };
}

type NormalizeOtioResult = NormalizeOtioSuccess | NormalizeOtioFailure;

export interface Gate9EvidenceCounts {
  droppedStableMetadataCount?: number;
  lossyCount?: number;
  unsupportedCount?: number;
}

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
  const resolvedPath = resolveManifestArtifactPath(
    manifestPath,
    manifest.base_timeline.path,
  );

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

// ── Stable ID Mapping ──────────────────────────────────────────────

/**
 * Map imported clips to exported clips using stable ID resolution.
 *
 * Priority:
 * 1. exact metadata match: exchange_clip_id
 * 2. exact metadata fallback: clip_id + timeline_version
 * 3. human-readable fallback: clip name contains clip_id
 * 4. diagnostic-only source signature: asset_id + src range (provisional only)
 */
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

  // Build lookup from exported exchange_clip_ids
  const exportedByExchangeId = new Map<string, NormalizedClip>();
  const exportedByClipId = new Map<string, NormalizedClip>();
  const exportedBySignature = new Map<string, NormalizedClip>();

  for (const clip of exportedClips) {
    if (clip.exchange_clip_id) {
      exportedByExchangeId.set(clip.exchange_clip_id, clip);
    }
    if (clip.clip_id) {
      exportedByClipId.set(clip.clip_id, clip);
    }
    // Signature: asset_id + src range
    const sig = `${clip.asset_id}:${clip.src_in_us}:${clip.src_out_us}`;
    exportedBySignature.set(sig, clip);
  }

  for (const imported of importedClips) {
    const fallbackConfidence: MappingConfidence = imported.metadata_lost
      ? "provisional"
      : "fallback";

    // Priority 1: exact exchange_clip_id match
    if (imported.exchange_clip_id && exportedByExchangeId.has(imported.exchange_clip_id)) {
      mapped.push({
        imported,
        exportedExchangeClipId: imported.exchange_clip_id,
        confidence: "exact",
      });
      continue;
    }

    // Priority 2: clip_id + timeline_version fallback
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

    // Priority 3: human-readable name fallback
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

    // Priority 4: diagnostic-only source signature (provisional)
    const importedSig = `${imported.asset_id}:${imported.src_in_us}:${imported.src_out_us}`;
    const sigMatch = exportedBySignature.get(importedSig);
    if (sigMatch && sigMatch.exchange_clip_id) {
      mapped.push({
        imported,
        exportedExchangeClipId: sigMatch.exchange_clip_id,
        confidence: "provisional",
      });
      continue;
    }

    // No match found
    unmapped.push(imported);
  }

  return { mapped, unmapped };
}

// ── Split / Duplicate / Ambiguous Normalization ────────────────────

export interface OneToManyResult {
  oneToOne: ClipMapping[];
  splitEntries: SplitEntry[];
  duplicateEntries: DuplicateEntry[];
  ambiguousEntries: AmbiguousEntry[];
}

/**
 * Normalize one-to-many mappings: split, duplicate, or ambiguous.
 *
 * When multiple imported clips map to the same parent exchange_clip_id:
 * - split_clip: source ranges don't overlap and cover the parent range
 * - duplicated_clip: overlapping source ranges (copies)
 * - ambiguous_one_to_many: can't determine split vs duplicate
 *
 * Instance normalization suffix sort:
 *   src_in_us → timeline_in_frame → imported ordinal
 */
export function normalizeOneToMany(
  mappings: ClipMapping[],
): OneToManyResult {
  // Group by parent exchange_clip_id
  const groups = new Map<string, ClipMapping[]>();
  for (const m of mappings) {
    const key = m.exportedExchangeClipId;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(m);
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

    // Sort by: src_in_us → timeline_in_frame → ordinal (stable)
    const sorted = [...group].sort((a, b) => {
      const srcDiff = a.imported.src_in_us - b.imported.src_in_us;
      if (srcDiff !== 0) return srcDiff;
      return a.imported.timeline_in_frame - b.imported.timeline_in_frame;
    });

    // Determine: split vs duplicate vs ambiguous
    const classification = classifyOneToMany(sorted);

    if (classification === "split") {
      const childIds = sorted.map(
        (_, i) => `${parentId}#S${String(i + 1).padStart(2, "0")}`,
      );
      splitEntries.push({
        parent_exchange_clip_id: parentId,
        child_ids: childIds,
        review_required: true,
      });
    } else if (classification === "duplicate") {
      const copyIds = sorted.slice(1).map(
        (_, i) => `${parentId}#D${String(i + 1).padStart(2, "0")}`,
      );
      duplicateEntries.push({
        parent_exchange_clip_id: parentId,
        retained_exchange_clip_id: parentId,
        copy_ids: copyIds,
        provenance: { basis: "duplicate_metadata_collision" },
        review_required: true,
      });
    } else {
      const candidates = sorted.map(
        (_, i) => `${parentId}#A${String(i + 1).padStart(2, "0")}`,
      );
      ambiguousEntries.push({
        parent_exchange_clip_id: parentId,
        candidates,
        reason: "Cannot deterministically distinguish split from duplicate",
        review_required: true,
      });
    }
  }

  return { oneToOne, splitEntries, duplicateEntries, ambiguousEntries };
}

/**
 * Classify a group of clips sharing the same parent exchange_clip_id.
 *
 * split: source ranges don't overlap (material overlap check)
 * duplicate: any two source ranges overlap significantly
 * ambiguous: can't decide
 */
export function classifyOneToMany(
  sorted: ClipMapping[],
): "split" | "duplicate" | "ambiguous" {
  // Check for material overlap between consecutive ranges
  let hasOverlap = false;
  let hasNonOverlap = false;

  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i].imported;
    const b = sorted[i + 1].imported;

    // Overlap test: ranges overlap if a.src_out_us > b.src_in_us
    if (a.src_out_us > b.src_in_us) {
      hasOverlap = true;
    } else {
      hasNonOverlap = true;
    }
  }

  if (hasOverlap && hasNonOverlap) return "ambiguous";
  if (hasOverlap) return "duplicate";
  if (hasNonOverlap) return "split";

  // Single pair — check overlap
  if (sorted.length === 2) {
    const a = sorted[0].imported;
    const b = sorted[1].imported;
    if (a.src_out_us > b.src_in_us) return "duplicate";
    return "split";
  }

  return "ambiguous";
}

// ── Lossy Item Detection ───────────────────────────────────────────

/**
 * Map profile surface names to schema-valid lossItem classification values.
 * The schema enum is fixed; profile surfaces may use different naming.
 */
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

/**
 * Detect lossy items based on capability profile surface classification.
 */
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

    if (metadataEvidence.length === 0) {
      continue;
    }

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

  // Unmapped clips → missing_stable_id
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

  // Split items → unmapped (one-to-many)
  for (const entry of splitEntries) {
    pushLossItem(unmappedItems, unmappedSeen, {
      classification: "split_clip",
      item_ref: `clip:${entry.parent_exchange_clip_id}`,
      reason: "one-to-many stable ID cannot be auto-reduced to a single canonical diff operation",
    });
  }

  // Duplicate items → unmapped
  for (const entry of duplicateEntries) {
    pushLossItem(unmappedItems, unmappedSeen, {
      classification: "duplicated_clip",
      item_ref: `clip:${entry.parent_exchange_clip_id}`,
      reason: "duplicate stable ID collision requires manual review",
    });
  }

  // Ambiguous items → unmapped
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

// ── Gate 9: Review Required Check ──────────────────────────────────

/**
 * Gate 9: Determine if import result requires human review.
 *
 * review_required if any of:
 * - unmapped clips exist
 * - ambiguous/provisional mapping
 * - split / duplicate / ambiguous one-to-many
 * - dropped stable metadata
 * - unsupported surface edit
 */
export function evaluateGate9(
  mappings: ClipMapping[],
  unmapped: NormalizedClip[],
  splitEntries: SplitEntry[],
  duplicateEntries: DuplicateEntry[],
  ambiguousEntries: AmbiguousEntry[],
  profile: NleCapabilityProfile,
  evidence: Gate9EvidenceCounts = {},
): boolean {
  // Unmapped clips
  if (unmapped.length > 0) return true;

  // Provisional mappings
  if (mappings.some((m) => m.confidence === "provisional")) {
    if (profile.import_policy.provisional_mapping_requires_review) return true;
  }

  // One-to-many items
  if (
    splitEntries.length > 0 ||
    duplicateEntries.length > 0 ||
    ambiguousEntries.length > 0
  ) {
    if (profile.import_policy.one_to_many_requires_review) return true;
  }

  if ((evidence.droppedStableMetadataCount ?? 0) > 0) return true;
  if ((evidence.lossyCount ?? 0) > 0) return true;
  if ((evidence.unsupportedCount ?? 0) > 0) return true;

  return false;
}

// ── Import Status Determination ────────────────────────────────────

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

// ── Build Import Report ────────────────────────────────────────────

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
  // Count by confidence level
  const exactMatches = oneToMany.oneToOne.filter(
    (m) => m.confidence === "exact",
  ).length;
  const fallbackMatches = oneToMany.oneToOne.filter(
    (m) => m.confidence === "fallback",
  ).length;
  const provisionalMatches = oneToMany.oneToOne.filter(
    (m) => m.confidence === "provisional",
  ).length;

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
  };

  // One-to-many items
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

  // Loss summary
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

  // NLE session
  if (nleSession) {
    report.nle_session = nleSession;
  }

  report.notes = [
    "No canonical artifact was mutated.",
  ];

  return report;
}

// ── Bridge Invocation for Import ───────────────────────────────────

/**
 * Invoke the Python bridge to normalize an OTIO file and extract clip metadata.
 * Returns normalized clip data or null on failure.
 */
export function normalizeOtioViaBridge(
  otioPath: string,
  outputPath: string,
  bridgeScriptPath: string,
  pythonPath?: string,
  cwd?: string,
): NormalizeOtioResult {
  const request: BridgeRequest = {
    request_id: `import_normalize_${Date.now()}`,
    command: "import_otio",
    input_path: otioPath,
    output_path: outputPath,
    options: {},
    expected_bridge_version: BRIDGE_VERSION,
  };

  try {
    const result = invokeBridge(request, {
      bridgeScriptPath,
      pythonPath,
      cwd,
    });

    if (result.timedOut) {
      return {
        ok: false,
        error: {
          message: "Bridge timed out while normalizing OTIO",
          details: {
            request_context: {
              command: request.command,
              input_path: request.input_path,
              output_path: request.output_path,
            },
            stderr: result.stderr,
            exit_code: result.exitCode,
            timed_out: true,
            bridge: result.response?.bridge,
            warnings: result.response?.warnings,
            bridge_error: result.response?.error,
          },
        },
      };
    }

    if (!result.response || !result.response.ok) {
      return {
        ok: false,
        error: {
          message:
            result.response?.error?.message ??
            "Bridge failed while normalizing OTIO",
          details: {
            request_context: {
              command: request.command,
              input_path: request.input_path,
              output_path: request.output_path,
            },
            stderr: result.stderr,
            exit_code: result.exitCode,
            timed_out: false,
            bridge: result.response?.bridge,
            warnings: result.response?.warnings,
            bridge_error: result.response?.error,
          },
        },
      };
    }

    const payloadPath = result.response.payload_path;
    if (!payloadPath || !fs.existsSync(payloadPath)) {
      return {
        ok: false,
        error: {
          message: "Bridge returned no normalized payload path",
          details: {
            request_context: {
              command: request.command,
              input_path: request.input_path,
              output_path: request.output_path,
            },
            stderr: result.stderr,
            exit_code: result.exitCode,
            timed_out: false,
            bridge: result.response.bridge,
            warnings: result.response.warnings,
            bridge_error: result.response.error,
          },
        },
      };
    }

    const normalized = JSON.parse(fs.readFileSync(payloadPath, "utf-8"));
    const clips: NormalizedClip[] = (normalized.clips ?? []).map((c: Record<string, unknown>) => ({
      exchange_clip_id: (c.exchange_clip_id as string) ?? "",
      clip_id: (c.clip_id as string) ?? "",
      track_id: (c.track_id as string) ?? "",
      asset_id: (c.asset_id as string) ?? "",
      segment_id: (c.segment_id as string) ?? "",
      src_in_us: (c.src_in_us as number) ?? 0,
      src_out_us: (c.src_out_us as number) ?? 0,
      timeline_in_frame: (c.timeline_in_frame as number) ?? 0,
      timeline_duration_frames: (c.timeline_duration_frames as number) ?? 0,
      name: typeof c.name === "string" ? c.name : undefined,
      enabled: typeof c.enabled === "boolean" ? c.enabled : undefined,
      metadata_lost: c.metadata_lost === true,
      track_kind: typeof c.track_kind === "string" ? c.track_kind : undefined,
      vendor_metadata_keys: normalizeStringArray(c.vendor_metadata_keys),
      track_vendor_metadata_keys: normalizeStringArray(c.track_vendor_metadata_keys),
      unknown_property_keys: normalizeStringArray(c.unknown_property_keys),
      track_unknown_property_keys: normalizeStringArray(c.track_unknown_property_keys),
      effect_names: normalizeStringArray(c.effect_names),
    }));

    return {
      ok: true,
      document: {
        project_id: typeof normalized.project_id === "string" ? normalized.project_id : "",
        handoff_id: typeof normalized.handoff_id === "string" ? normalized.handoff_id : "",
        timeline_version:
          typeof normalized.timeline_version === "string"
            ? normalized.timeline_version
            : "",
        clips,
      },
      fingerprint: result.response.bridge,
      warnings: result.response.warnings,
    };
  } catch (err) {
    const failure = err as {
      message?: string;
      stderr?: string;
      request?: BridgeRequest | null;
    };

    return {
      ok: false,
      error: {
        message: failure.message ?? "Unexpected bridge invocation failure",
        details: {
          request_context: {
            command: failure.request?.command ?? request.command,
            input_path: failure.request?.input_path ?? request.input_path,
            output_path: failure.request?.output_path ?? request.output_path,
          },
          stderr: failure.stderr ?? "",
          exit_code: null,
          timed_out: false,
        },
      },
    };
  }
}

// ── Full Import Orchestration ──────────────────────────────────────

/**
 * Execute the full handoff import pipeline.
 *
 * Without Python/OTIO available, this operates in "offline" mode:
 * the caller can pass pre-normalized clip data instead.
 */
export function executeHandoffImport(
  input: HandoffImportInput,
): HandoffImportResult | { error: ImportError } {
  // 1. Load manifest
  if (!fs.existsSync(input.manifestPath)) {
    return {
      error: {
        code: "MANIFEST_NOT_FOUND",
        message: `Handoff manifest not found: ${input.manifestPath}`,
      },
    };
  }
  const manifest = parseYaml(
    fs.readFileSync(input.manifestPath, "utf-8"),
  ) as HandoffManifest;

  // 2. Check imported OTIO exists
  if (!fs.existsSync(input.importedOtioPath)) {
    return {
      error: {
        code: "IMPORTED_OTIO_NOT_FOUND",
        message: `Imported OTIO not found: ${input.importedOtioPath}`,
      },
    };
  }

  // 3. Load capability profile
  if (!fs.existsSync(input.profilePath)) {
    return {
      error: {
        code: "PROFILE_NOT_FOUND",
        message: `Capability profile not found: ${input.profilePath}`,
      },
    };
  }
  const profile = loadCapabilityProfile(input.profilePath);

  // 4. Verify current canonical base timeline matches the export manifest
  const baseHashCheck = verifyBaseTimelineHash(input.manifestPath, manifest);
  if (!baseHashCheck.ok) {
    return { error: baseHashCheck.error };
  }

  // 5. Prepare output directory
  fs.mkdirSync(input.outputDir, { recursive: true });
  const normalizedDir = path.join(input.outputDir, "normalized");
  fs.mkdirSync(normalizedDir, { recursive: true });

  // 6. Normalize imported OTIO via bridge
  const bridgeScriptPath = path.join(
    path.dirname(new URL(import.meta.url).pathname),
    "otio-bridge.py",
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

  // 7. Normalize exported OTIO for comparison (if available)
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

  // 8. Bridge fingerprint mismatch check
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

  // 9. Stable ID mapping
  const { mapped, unmapped } = mapClips(
    exportedClips,
    importResult.document.clips,
    manifest.project_id,
    manifest.base_timeline.version,
  );

  // 10. One-to-many normalization
  const oneToMany = normalizeOneToMany(mapped);

  const lossDetection = detectLossyItems(
    profile,
    mapped,
    unmapped,
    oneToMany.splitEntries,
    oneToMany.duplicateEntries,
    oneToMany.ambiguousEntries,
  );

  // 11. Gate 9
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

  // 12. Determine status
  const importedAt = new Date().toISOString();
  const status = determineImportStatus(
    reviewRequired,
    unmapped.length,
    importResult.document.clips.length,
    fingerprintSeverity,
  );

  // 13. Build report
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

  // 14. Write report
  const reportPath = path.join(input.outputDir, "roundtrip_import_report.yaml");
  fs.writeFileSync(reportPath, stringifyYaml(report), "utf-8");

  return {
    report,
    reportPath,
    reviewRequired,
    bridgeFingerprint: importResult.fingerprint,
  };
}

// ── Offline Import (no bridge required) ────────────────────────────

/**
 * Run the import analysis pipeline with pre-normalized clip data.
 * Used when Python/OTIO bridge is not available.
 */
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

  // Stable ID mapping
  const { mapped, unmapped } = mapClips(
    exportedClips,
    importedClips,
    manifest.project_id,
    manifest.base_timeline.version,
  );

  // One-to-many normalization
  const oneToMany = normalizeOneToMany(mapped);

  const lossDetection = detectLossyItems(
    profile,
    mapped,
    unmapped,
    oneToMany.splitEntries,
    oneToMany.duplicateEntries,
    oneToMany.ambiguousEntries,
  );

  // Gate 9
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

  // Fingerprint severity
  const fpSeverity = evaluateFingerprintMismatch(manifest.bridge, bridgeFingerprint);

  // Status
  const status = determineImportStatus(
    reviewRequired,
    unmapped.length,
    importedClips.length,
    fpSeverity,
  );

  // Report
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
