/**
 * M3.5 Phase 4: Diff Analyzer
 *
 * Compares base timeline clips with imported clips (via import report's mapped_clips)
 * and produces a human_revision_diff.yaml — an agent-consumable structured diff.
 *
 * Responsibilities:
 * - edit_type classification (trim, reorder, enable_disable, track_move, simple_transition, timeline_marker_add)
 * - ripple_shift detection (upstream trim ripple vs intentional reorder)
 * - unmapped_edit classification (plugin_effect, complex_title, color_finish, etc.)
 * - summary statistics
 * - human_revision_diff.yaml generation (schema-validated)
 */

import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import type {
  NormalizedClip,
  ClipMapping,
  RoundtripImportReport,
  LossItem,
  OneToManyResult,
} from "./import.js";
import type {
  NleCapabilityProfile,
  SurfaceMode,
} from "./bridge-contract.js";

const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020") as new (opts: Record<string, unknown>) => {
  compile(schema: object): {
    (data: unknown): boolean;
    errors?: Array<{ instancePath: string; message?: string }> | null;
  };
};
const addFormats = require("ajv-formats") as (ajv: unknown) => void;

// ── Types ──────────────────────────────────────────────────────────

export type DiffEditType =
  | "trim"
  | "reorder"
  | "enable_disable"
  | "track_move"
  | "simple_transition"
  | "timeline_marker_add";

export type UnmappedClassification =
  | "complex_title"
  | "plugin_effect"
  | "color_finish"
  | "advanced_audio_finish"
  | "speed_change"
  | "nested_sequence"
  | "deleted_clip_without_disable"
  | "missing_stable_id"
  | "split_clip"
  | "duplicated_clip"
  | "ambiguous_one_to_many"
  | "track_reorder"
  | "clip_marker_add"
  | "note_text_add"
  | "ambiguous_mapping"
  | "unknown_vendor_extension";

export type DiffConfidence = "exact" | "fallback" | "provisional";

export type DiffSurface = "verified_roundtrip" | "provisional_roundtrip" | "report_only";

export interface DiffOperationTarget {
  exchange_clip_id: string;
  clip_id?: string;
  segment_id?: string;
  asset_id?: string;
  track_id?: string;
}

export interface ClipState {
  src_in_us?: number;
  src_out_us?: number;
  timeline_in_frame?: number;
  timeline_duration_frames?: number;
}

export interface ClipDelta {
  in_us?: number;
  out_us?: number;
  duration_frames?: number;
}

export interface DiffOperation {
  operation_id: string;
  type: DiffEditType;
  target: DiffOperationTarget;
  before?: ClipState;
  after?: ClipState;
  delta?: ClipDelta;
  mapped_via?: string;
  confidence?: DiffConfidence;
  surface?: DiffSurface;
  transition_type?: string;
  transition_duration_frames?: number;
  marker_frame?: number;
  marker_label?: string;
  from_track_id?: string;
  to_track_id?: string;
  enabled?: boolean;
}

export interface UnmappedEdit {
  classification: UnmappedClassification;
  item_ref: string;
  derived_child_ids?: string[];
  copy_ids?: string[];
  review_required: boolean;
  reason: string;
}

export interface DiffSummary {
  trim?: number;
  reorder?: number;
  enable_disable?: number;
  track_move?: number;
  simple_transition?: number;
  timeline_marker_add?: number;
  unmapped?: number;
}

export type DiffStatus = "clean" | "lossy" | "review_required";

export interface HumanRevisionDiff {
  version: 1;
  project_id: string;
  handoff_id: string;
  base_timeline_version: string;
  capability_profile_id: string;
  status: DiffStatus;
  summary: DiffSummary;
  operations?: DiffOperation[];
  unmapped_edits?: UnmappedEdit[];
}

export class HumanRevisionDiffValidationError extends Error {
  readonly errors: string[];

  constructor(errors: string[]) {
    super(`human_revision_diff schema validation failed: ${errors.join("; ")}`);
    this.name = "HumanRevisionDiffValidationError";
    this.errors = errors;
  }
}

const HUMAN_REVISION_DIFF_SCHEMA_PATH = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../../schemas/human-revision-diff.schema.json",
);
const HUMAN_REVISION_DIFF_SCHEMA = JSON.parse(
  fs.readFileSync(HUMAN_REVISION_DIFF_SCHEMA_PATH, "utf-8"),
);
const HUMAN_REVISION_DIFF_AJV = new Ajv2020({ allErrors: true, strict: false });
addFormats(HUMAN_REVISION_DIFF_AJV);
const VALIDATE_HUMAN_REVISION_DIFF = HUMAN_REVISION_DIFF_AJV.compile(
  HUMAN_REVISION_DIFF_SCHEMA,
);

export function validateHumanRevisionDiff(
  diff: unknown,
): asserts diff is HumanRevisionDiff {
  const valid = VALIDATE_HUMAN_REVISION_DIFF(diff);
  if (valid) return;
  const errors = (VALIDATE_HUMAN_REVISION_DIFF.errors ?? []).map(
    (error) => `${error.instancePath || "/"}: ${error.message ?? "unknown"}`,
  );
  throw new HumanRevisionDiffValidationError(errors);
}

// ── Diff Analysis Input ────────────────────────────────────────────

export interface DiffAnalysisInput {
  projectId: string;
  handoffId: string;
  baseTimelineVersion: string;
  capabilityProfileId: string;
  profile: NleCapabilityProfile;
  exportedClips: NormalizedClip[];
  oneToOne: ClipMapping[];
  oneToMany: OneToManyResult;
  unmappedClips: NormalizedClip[];
  importReport: RoundtripImportReport;
  /** Optional transition data from imported timeline */
  importedTransitions?: ImportedTransition[];
  /** Optional marker data from imported timeline */
  importedMarkers?: ImportedMarker[];
}

export interface ImportedTransition {
  exchange_clip_id: string;
  adjacent_exchange_clip_id?: string;
  transition_type: string;
  duration_frames: number;
}

export interface ImportedMarker {
  frame: number;
  label: string;
  scope: "timeline" | "clip";
  exchange_clip_id?: string;
}

// ── Ripple Normalization ───────────────────────────────────────────

interface TrackClipPair {
  exported: NormalizedClip;
  imported: NormalizedClip;
  confidence: DiffConfidence;
  mappedVia: string;
}

/**
 * Build a map of exported exchange_clip_id → exported clip for quick lookup.
 */
function buildExportedLookup(
  exportedClips: NormalizedClip[],
): Map<string, NormalizedClip> {
  const lookup = new Map<string, NormalizedClip>();
  for (const clip of exportedClips) {
    if (clip.exchange_clip_id) {
      lookup.set(clip.exchange_clip_id, clip);
    }
  }
  return lookup;
}

/**
 * Group 1:1 mapped clips by track_id for peer-set analysis.
 * Uses the *exported* clip's track_id as the logical track.
 */
function groupByTrack(
  pairs: TrackClipPair[],
): Map<string, TrackClipPair[]> {
  const groups = new Map<string, TrackClipPair[]>();
  for (const pair of pairs) {
    const trackId = pair.exported.track_id;
    if (!groups.has(trackId)) groups.set(trackId, []);
    groups.get(trackId)!.push(pair);
  }
  return groups;
}

/**
 * Sort pairs by exported timeline_in_frame to get the base ordering.
 */
function sortByExportedPosition(pairs: TrackClipPair[]): TrackClipPair[] {
  return [...pairs].sort(
    (a, b) => a.exported.timeline_in_frame - b.exported.timeline_in_frame,
  );
}

/**
 * Compute cumulative trim deltas for upstream clips on the same track.
 *
 * For each clip in the base order, the upstream trim ripple is the sum
 * of all duration changes from clips that appear earlier on the same track.
 *
 * Returns a Map: exchange_clip_id → ripple_shift_frames
 */
export function computeRippleShifts(
  trackPairs: TrackClipPair[],
): Map<string, number> {
  const sorted = sortByExportedPosition(trackPairs);
  const rippleMap = new Map<string, number>();
  let cumulativeDelta = 0;

  for (const pair of sorted) {
    // This clip's ripple shift is the cumulative delta from upstream clips
    rippleMap.set(pair.exported.exchange_clip_id, cumulativeDelta);

    // Compute this clip's duration delta and add to cumulative
    const baseDuration = pair.exported.timeline_duration_frames;
    const importedDuration = pair.imported.timeline_duration_frames;
    const durationDelta = importedDuration - baseDuration;
    cumulativeDelta += durationDelta;
  }

  return rippleMap;
}

/**
 * Determine if a clip's position change is a reorder or just a ripple shift.
 *
 * A position change is a reorder if the *relative order* within the peer set
 * changed after ripple normalization. If the position change is exactly
 * explained by upstream trim ripple, it's a ripple_shift (not a reorder).
 *
 * Returns true if this is a genuine reorder (not a ripple shift).
 */
export function isGenuineReorder(
  trackPairs: TrackClipPair[],
): Set<string> {
  const sorted = sortByExportedPosition(trackPairs);
  if (sorted.length < 2) return new Set();

  const rippleMap = computeRippleShifts(sorted);
  const reorderedIds = new Set<string>();

  // Compute normalized imported positions (imported_pos - ripple_shift)
  const normalizedPositions: Array<{
    exchangeClipId: string;
    normalizedPos: number;
    basePos: number;
  }> = [];

  for (const pair of sorted) {
    const rippleShift = rippleMap.get(pair.exported.exchange_clip_id) ?? 0;
    const normalizedPos = pair.imported.timeline_in_frame - rippleShift;
    normalizedPositions.push({
      exchangeClipId: pair.exported.exchange_clip_id,
      normalizedPos,
      basePos: pair.exported.timeline_in_frame,
    });
  }

  // Check if the relative order changed
  // Base order is the sorted order (already sorted by basePos)
  // Normalized imported order: sort by normalizedPos
  const importedOrder = [...normalizedPositions].sort(
    (a, b) => a.normalizedPos - b.normalizedPos,
  );

  for (let i = 0; i < sorted.length; i++) {
    if (normalizedPositions[i].exchangeClipId !== importedOrder[i].exchangeClipId) {
      // Find which clips moved
      // Every clip that isn't in its original relative position is reordered
      const baseIds = normalizedPositions.map((p) => p.exchangeClipId);
      const importedIds = importedOrder.map((p) => p.exchangeClipId);
      for (let j = 0; j < baseIds.length; j++) {
        if (baseIds[j] !== importedIds[j]) {
          reorderedIds.add(baseIds[j]);
        }
      }
      break;
    }
  }

  return reorderedIds;
}

// ── Diff Classification ────────────────────────────────────────────

/**
 * Get the surface mode for a given edit type from the capability profile.
 */
function getSurfaceMode(
  profile: NleCapabilityProfile,
  surfaceName: string,
): SurfaceMode | undefined {
  const entry = profile.surfaces[surfaceName];
  return entry?.mode;
}

/**
 * Convert surface mode to diff surface classification.
 */
function surfaceModeToDiffSurface(mode: SurfaceMode | undefined): DiffSurface {
  switch (mode) {
    case "verified_roundtrip":
      return "verified_roundtrip";
    case "provisional_roundtrip":
      return "provisional_roundtrip";
    default:
      return "report_only";
  }
}

/**
 * Determine the mapped_via string from confidence level.
 */
function confidenceToMappedVia(confidence: DiffConfidence): string {
  switch (confidence) {
    case "exact":
      return "metadata.exchange_clip_id";
    case "fallback":
      return "clip_id_or_name_fallback";
    case "provisional":
      return "source_signature_provisional";
  }
}

function inferTrackKind(clip: NormalizedClip): string {
  if (clip.track_kind) return clip.track_kind;
  if (clip.track_id.startsWith("V")) return "video";
  if (clip.track_id.startsWith("A")) return "audio";
  if (clip.track_id.startsWith("O")) return "overlay";
  if (clip.track_id.startsWith("C")) return "caption";
  return "unknown";
}

function trackOrdinal(trackId: string): number {
  const match = trackId.match(/(\d+)$/);
  return match ? parseInt(match[1], 10) : Number.MAX_SAFE_INTEGER;
}

function sortTrackIds(trackIds: Iterable<string>): string[] {
  return [...trackIds].sort((left, right) => {
    const ordinalDiff = trackOrdinal(left) - trackOrdinal(right);
    if (ordinalDiff !== 0) return ordinalDiff;
    return left.localeCompare(right);
  });
}

function isUnmappedClassification(
  value: string,
): value is UnmappedClassification {
  return [
    "complex_title",
    "plugin_effect",
    "color_finish",
    "advanced_audio_finish",
    "speed_change",
    "nested_sequence",
    "deleted_clip_without_disable",
    "missing_stable_id",
    "split_clip",
    "duplicated_clip",
    "ambiguous_one_to_many",
    "track_reorder",
    "clip_marker_add",
    "note_text_add",
    "ambiguous_mapping",
    "unknown_vendor_extension",
  ].includes(value);
}

function pushUnmappedEdit(
  target: UnmappedEdit[],
  seen: Set<string>,
  item: UnmappedEdit,
): void {
  const key = `${item.classification}:${item.item_ref}`;
  if (seen.has(key)) return;
  seen.add(key);
  target.push(item);
}

function importLossItemToUnmappedEdit(
  item: LossItem,
  reviewRequired: boolean,
): UnmappedEdit | null {
  if (!isUnmappedClassification(item.classification)) {
    return null;
  }
  return {
    classification: item.classification,
    item_ref: item.item_ref,
    review_required: reviewRequired,
    reason: item.reason,
  };
}

function buildTransitionItemRef(transition: ImportedTransition): string {
  const adjacent = transition.adjacent_exchange_clip_id
    ? `,adjacent=${transition.adjacent_exchange_clip_id}`
    : "";
  return `transition@clip=${transition.exchange_clip_id},type=${transition.transition_type}${adjacent}`;
}

function detectGlobalTrackReorders(
  pairs: TrackClipPair[],
  reviewRequired: boolean,
): {
  affectedClipIds: Set<string>;
  edits: UnmappedEdit[];
} {
  const affectedClipIds = new Set<string>();
  const edits: UnmappedEdit[] = [];
  const pairsByKind = new Map<string, TrackClipPair[]>();

  for (const pair of pairs) {
    const exportedKind = inferTrackKind(pair.exported);
    const importedKind = inferTrackKind(pair.imported);
    if (exportedKind !== importedKind) continue;
    if (!pairsByKind.has(exportedKind)) pairsByKind.set(exportedKind, []);
    pairsByKind.get(exportedKind)!.push(pair);
  }

  for (const [kind, kindPairs] of pairsByKind) {
    const exportedToImported = new Map<string, Set<string>>();
    const importedToExported = new Map<string, Set<string>>();

    for (const pair of kindPairs) {
      if (!exportedToImported.has(pair.exported.track_id)) {
        exportedToImported.set(pair.exported.track_id, new Set());
      }
      exportedToImported.get(pair.exported.track_id)!.add(pair.imported.track_id);

      if (!importedToExported.has(pair.imported.track_id)) {
        importedToExported.set(pair.imported.track_id, new Set());
      }
      importedToExported.get(pair.imported.track_id)!.add(pair.exported.track_id);
    }

    if (exportedToImported.size < 2 || importedToExported.size < 2) {
      continue;
    }
    if ([...exportedToImported.values()].some((value) => value.size !== 1)) {
      continue;
    }
    if ([...importedToExported.values()].some((value) => value.size !== 1)) {
      continue;
    }

    const exportedOrder = sortTrackIds(exportedToImported.keys());
    const importedOrder = sortTrackIds(importedToExported.keys());
    const importedRanks = exportedOrder.map((trackId) => {
      const mappedTrackId = [...exportedToImported.get(trackId)!][0];
      return importedOrder.indexOf(mappedTrackId);
    });

    const reordered = importedRanks.some((rank, index) => rank !== index);
    if (!reordered) continue;

    for (const pair of kindPairs) {
      const mappedTrackId = [...exportedToImported.get(pair.exported.track_id)!][0];
      if (mappedTrackId !== pair.imported.track_id) continue;
      if (pair.exported.track_id === pair.imported.track_id) continue;
      affectedClipIds.add(pair.exported.exchange_clip_id);
    }

    edits.push({
      classification: "track_reorder",
      item_ref: `tracks:${kind}:${exportedOrder.join(">")}=>${importedOrder.join(">")}`,
      review_required: reviewRequired,
      reason: `global ${kind} track order changed without clip-level logical reassignment`,
    });
  }

  return { affectedClipIds, edits };
}

/**
 * Analyze all 1:1 mapped clips and produce diff operations.
 */
export function analyzeDiffs(input: DiffAnalysisInput): HumanRevisionDiff {
  const {
    projectId,
    handoffId,
    baseTimelineVersion,
    capabilityProfileId,
    profile,
    exportedClips,
    oneToOne,
    oneToMany,
    unmappedClips,
    importReport,
    importedTransitions,
    importedMarkers,
  } = input;

  const exportedLookup = buildExportedLookup(exportedClips);
  const operations: DiffOperation[] = [];
  const unmappedEdits: UnmappedEdit[] = [];
  const unmappedSeen = new Set<string>();
  let opCounter = 0;
  let hasLossyEvidence = false;
  const reviewRequiredDefault = importReport.loss_summary?.review_required
    ?? profile.import_policy.unmapped_edit_requires_review;

  function nextOpId(): string {
    opCounter++;
    return `HRD_${String(opCounter).padStart(4, "0")}`;
  }

  // Build TrackClipPair list for 1:1 mappings
  const pairs: TrackClipPair[] = [];
  for (const mapping of oneToOne) {
    const exported = exportedLookup.get(mapping.exportedExchangeClipId);
    if (!exported) continue;
    pairs.push({
      exported,
      imported: mapping.imported,
      confidence: mapping.confidence,
      mappedVia: confidenceToMappedVia(mapping.confidence),
    });
  }

  // Group by track for ripple normalization and reorder detection
  const trackGroups = groupByTrack(pairs);
  const reorderedIds = new Set<string>();

  for (const [, trackPairs] of trackGroups) {
    const trackReorders = isGenuineReorder(trackPairs);
    for (const id of trackReorders) {
      reorderedIds.add(id);
    }
  }

  const trackReorderDetection = detectGlobalTrackReorders(
    pairs,
    reviewRequiredDefault,
  );
  for (const edit of trackReorderDetection.edits) {
    pushUnmappedEdit(unmappedEdits, unmappedSeen, edit);
  }

  // Analyze each 1:1 pair
  for (const pair of pairs) {
    const { exported, imported, confidence, mappedVia } = pair;
    const exchangeClipId = exported.exchange_clip_id;

    const target: DiffOperationTarget = {
      exchange_clip_id: exchangeClipId,
      clip_id: exported.clip_id,
      segment_id: exported.segment_id,
      asset_id: exported.asset_id,
      track_id: exported.track_id,
    };

    // ── trim detection ──
    const srcInChanged = imported.src_in_us !== exported.src_in_us;
    const srcOutChanged = imported.src_out_us !== exported.src_out_us;
    if (srcInChanged || srcOutChanged) {
      const trimMode = getSurfaceMode(profile, "trim");
      if (trimMode === "verified_roundtrip" || trimMode === "provisional_roundtrip") {
        operations.push({
          operation_id: nextOpId(),
          type: "trim",
          target,
          before: {
            src_in_us: exported.src_in_us,
            src_out_us: exported.src_out_us,
            timeline_in_frame: exported.timeline_in_frame,
            timeline_duration_frames: exported.timeline_duration_frames,
          },
          after: {
            src_in_us: imported.src_in_us,
            src_out_us: imported.src_out_us,
            timeline_in_frame: imported.timeline_in_frame,
            timeline_duration_frames: imported.timeline_duration_frames,
          },
          delta: {
            in_us: imported.src_in_us - exported.src_in_us,
            out_us: imported.src_out_us - exported.src_out_us,
            duration_frames: imported.timeline_duration_frames - exported.timeline_duration_frames,
          },
          mapped_via: mappedVia,
          confidence,
          surface: surfaceModeToDiffSurface(trimMode),
        });
      }
    }

    // ── track_move detection ──
    const exportedTrackAssignment = `${inferTrackKind(exported)}:${exported.track_id}`;
    const importedTrackAssignment = `${inferTrackKind(imported)}:${imported.track_id}`;
    if (
      exportedTrackAssignment !== importedTrackAssignment &&
      !trackReorderDetection.affectedClipIds.has(exchangeClipId)
    ) {
      const trackMoveMode = getSurfaceMode(profile, "track_move");
      if (trackMoveMode && trackMoveMode !== "report_only" && trackMoveMode !== "lossy") {
        operations.push({
          operation_id: nextOpId(),
          type: "track_move",
          target,
          from_track_id: exported.track_id,
          to_track_id: imported.track_id,
          mapped_via: mappedVia,
          confidence,
          surface: surfaceModeToDiffSurface(trackMoveMode),
        });
      }
    }

    // ── reorder detection (same track only, after ripple normalization) ──
    if (
      imported.track_id === exported.track_id &&
      reorderedIds.has(exchangeClipId)
    ) {
      const reorderMode = getSurfaceMode(profile, "reorder");
      if (reorderMode === "verified_roundtrip" || reorderMode === "provisional_roundtrip") {
        operations.push({
          operation_id: nextOpId(),
          type: "reorder",
          target,
          before: {
            timeline_in_frame: exported.timeline_in_frame,
            timeline_duration_frames: exported.timeline_duration_frames,
          },
          after: {
            timeline_in_frame: imported.timeline_in_frame,
            timeline_duration_frames: imported.timeline_duration_frames,
          },
          mapped_via: mappedVia,
          confidence,
          surface: surfaceModeToDiffSurface(reorderMode),
        });
      }
    }

    // ── enable_disable detection ──
    if (
      imported.enabled !== undefined &&
      exported.enabled !== undefined &&
      imported.enabled !== exported.enabled
    ) {
      const enableMode = getSurfaceMode(profile, "enable_disable");
      if (enableMode === "verified_roundtrip" || enableMode === "provisional_roundtrip") {
        operations.push({
          operation_id: nextOpId(),
          type: "enable_disable",
          target,
          enabled: imported.enabled,
          mapped_via: mappedVia,
          confidence,
          surface: surfaceModeToDiffSurface(enableMode),
        });
      }
    }

    if (confidence === "provisional") {
      pushUnmappedEdit(unmappedEdits, unmappedSeen, {
        classification: "ambiguous_mapping",
        item_ref: `clip:${exchangeClipId}`,
        review_required: true,
        reason: "mapping provenance is provisional and requires human review",
      });
    }
  }

  // ── simple_transition detection ──
  if (importedTransitions) {
    const transitionMode = getSurfaceMode(profile, "simple_transition");
    const allowedTypes = profile.surfaces.simple_transition?.allowed_types ?? [];
    for (const transition of importedTransitions) {
      const isAllowedType = allowedTypes.length === 0
        || allowedTypes.includes(transition.transition_type);
      const canEmitOperation = transitionMode
        && transitionMode !== "report_only"
        && transitionMode !== "lossy";

      if (isAllowedType && canEmitOperation) {
        operations.push({
          operation_id: nextOpId(),
          type: "simple_transition",
          target: {
            exchange_clip_id: transition.exchange_clip_id,
          },
          transition_type: transition.transition_type,
          transition_duration_frames: transition.duration_frames,
          surface: surfaceModeToDiffSurface(transitionMode),
        });
        continue;
      }

      pushUnmappedEdit(unmappedEdits, unmappedSeen, {
        classification: "unknown_vendor_extension",
        item_ref: buildTransitionItemRef(transition),
        review_required: true,
        reason: isAllowedType
          ? "transition is outside diffable capability surface"
          : `transition type ${transition.transition_type} is outside capability profile allowlist`,
      });
    }
  }

  // ── timeline_marker_add detection ──
  if (importedMarkers) {
    const markerMode = getSurfaceMode(profile, "timeline_marker_add");
    if (markerMode && markerMode !== "report_only" && markerMode !== "lossy") {
      for (const marker of importedMarkers) {
        if (marker.scope !== "timeline") continue;
        operations.push({
          operation_id: nextOpId(),
          type: "timeline_marker_add",
          target: {
            exchange_clip_id: marker.exchange_clip_id ?? "",
          },
          marker_frame: marker.frame,
          marker_label: marker.label,
          surface: surfaceModeToDiffSurface(markerMode),
        });
      }
    }

    // Clip markers → unmapped_edits
    const clipMarkerMode = getSurfaceMode(profile, "clip_marker_add");
    if (clipMarkerMode === "report_only") {
      for (const marker of importedMarkers) {
        if (marker.scope === "clip" && marker.exchange_clip_id) {
          pushUnmappedEdit(unmappedEdits, unmappedSeen, {
            classification: "clip_marker_add",
            item_ref: `marker@clip=${marker.exchange_clip_id},frame=${marker.frame}`,
            review_required: reviewRequiredDefault,
            reason: "clip-attached markers are report-only in capability profile",
          });
        }
      }
    }
  }

  // ── unmapped_edits from one-to-many ──
  for (const entry of oneToMany.splitEntries) {
    pushUnmappedEdit(unmappedEdits, unmappedSeen, {
      classification: "split_clip",
      item_ref: `clip:${entry.parent_exchange_clip_id}`,
      derived_child_ids: entry.child_ids,
      review_required: true,
      reason: "one-to-many stable ID requires human restructuring",
    });
  }

  for (const entry of oneToMany.duplicateEntries) {
    pushUnmappedEdit(unmappedEdits, unmappedSeen, {
      classification: "duplicated_clip",
      item_ref: `clip:${entry.parent_exchange_clip_id}`,
      copy_ids: entry.copy_ids,
      review_required: true,
      reason: "duplicate stable ID copy is preserved as provenance only",
    });
  }

  for (const entry of oneToMany.ambiguousEntries) {
    pushUnmappedEdit(unmappedEdits, unmappedSeen, {
      classification: "ambiguous_one_to_many",
      item_ref: `clip:${entry.parent_exchange_clip_id}`,
      review_required: true,
      reason: entry.reason,
    });
  }

  // ── unmapped clips → classification ──
  for (const clip of unmappedClips) {
    const ref = clip.exchange_clip_id
      ? `clip:${clip.exchange_clip_id}`
      : `clip@track=${clip.track_id},index=unmapped`;
    pushUnmappedEdit(unmappedEdits, unmappedSeen, {
      classification: "missing_stable_id",
      item_ref: ref,
      review_required: true,
      reason: "imported clip has no matching exchange_clip_id in exported base",
    });
  }

  // ── exported clips removed without disable → unmapped_edits ──
  const seenExportedIds = new Set<string>();
  for (const mapping of oneToOne) {
    seenExportedIds.add(mapping.exportedExchangeClipId);
  }
  for (const entry of oneToMany.splitEntries) {
    seenExportedIds.add(entry.parent_exchange_clip_id);
  }
  for (const entry of oneToMany.duplicateEntries) {
    seenExportedIds.add(entry.parent_exchange_clip_id);
  }
  for (const entry of oneToMany.ambiguousEntries) {
    seenExportedIds.add(entry.parent_exchange_clip_id);
  }
  for (const clip of exportedClips) {
    if (seenExportedIds.has(clip.exchange_clip_id)) continue;
    pushUnmappedEdit(unmappedEdits, unmappedSeen, {
      classification: "deleted_clip_without_disable",
      item_ref: `clip:${clip.exchange_clip_id}`,
      review_required: true,
      reason: "exported clip is absent in import result and was not expressed as disable",
    });
  }

  // ── import report loss evidence → unmapped_edits ──
  const lossSummary = importReport.loss_summary;
  if (lossSummary) {
    for (const item of lossSummary.lossy_items ?? []) {
      const unmappedEdit = importLossItemToUnmappedEdit(item, reviewRequiredDefault);
      if (!unmappedEdit) continue;
      hasLossyEvidence = true;
      pushUnmappedEdit(unmappedEdits, unmappedSeen, unmappedEdit);
    }

    for (const item of lossSummary.unsupported_items ?? []) {
      const unmappedEdit = importLossItemToUnmappedEdit(item, reviewRequiredDefault);
      if (!unmappedEdit) continue;
      pushUnmappedEdit(unmappedEdits, unmappedSeen, unmappedEdit);
    }

    for (const item of lossSummary.unmapped_items ?? []) {
      const unmappedEdit = importLossItemToUnmappedEdit(item, reviewRequiredDefault);
      if (!unmappedEdit) continue;
      pushUnmappedEdit(unmappedEdits, unmappedSeen, unmappedEdit);
    }
  }

  // ── Build summary ──
  const summary: DiffSummary = {};
  const typeCounts = new Map<DiffEditType, number>();
  for (const op of operations) {
    typeCounts.set(op.type, (typeCounts.get(op.type) ?? 0) + 1);
  }
  if (typeCounts.has("trim")) summary.trim = typeCounts.get("trim")!;
  if (typeCounts.has("reorder")) summary.reorder = typeCounts.get("reorder")!;
  if (typeCounts.has("enable_disable")) summary.enable_disable = typeCounts.get("enable_disable")!;
  if (typeCounts.has("track_move")) summary.track_move = typeCounts.get("track_move")!;
  if (typeCounts.has("simple_transition")) summary.simple_transition = typeCounts.get("simple_transition")!;
  if (typeCounts.has("timeline_marker_add")) summary.timeline_marker_add = typeCounts.get("timeline_marker_add")!;
  if (unmappedEdits.length > 0) summary.unmapped = unmappedEdits.length;

  // ── Determine status ──
  let status: DiffStatus = "clean";
  if (unmappedEdits.some((e) => e.review_required)) {
    status = "review_required";
  } else if (hasLossyEvidence) {
    status = "lossy";
  }

  // ── Build result ──
  const diff: HumanRevisionDiff = {
    version: 1,
    project_id: projectId,
    handoff_id: handoffId,
    base_timeline_version: baseTimelineVersion,
    capability_profile_id: capabilityProfileId,
    status,
    summary,
  };

  if (operations.length > 0) {
    diff.operations = operations;
  }
  if (unmappedEdits.length > 0) {
    diff.unmapped_edits = unmappedEdits;
  }

  validateHumanRevisionDiff(diff);
  return diff;
}
