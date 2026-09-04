/**
 * Editorial storyboard review projection — generic data model (Issue #7).
 *
 * A review projection is a deterministic, offline HTML storyboard generated
 * from canonical artifacts. The generator never mutates canonical artifacts
 * and never assumes a specific aspect ratio, platform, or media kind.
 */

export type StoryboardSourceMode = "blueprint" | "timeline" | "compare";

export type ProjectionStatus = "CURRENT" | "STALE" | "INVALID";

export type StoryboardMediaKind = "video" | "image" | "sequence" | "audio" | "unknown";

/** Canonical artifact roles tracked by the projection manifest. */
export type ArtifactRole =
  | "brief"
  | "selects"
  | "blueprint"
  | "uncertainty"
  | "timeline"
  | "source_map"
  | "policy";

export interface ArtifactInputRecord {
  role: ArtifactRole;
  /** Project-relative POSIX path of the input artifact. */
  path: string;
  /** `sha256:<hex>` of the file bytes; null when the optional artifact is absent. */
  hash: string | null;
  required: boolean;
}

/**
 * A delivery canvas resolved without guessing. When no delivery profile and
 * no timeline sequence exist the basis is "unspecified" and the projection
 * falls back to the source aspect explicitly labeled as such.
 */
export interface ResolvedCanvas {
  aspect_ratio_label: string;
  /** width / height as a number; null when unknown. */
  aspect: number | null;
  width: number | null;
  height: number | null;
  fps_num: number | null;
  fps_den: number | null;
  basis: "delivery_profile" | "timeline_sequence" | "unspecified";
}

export interface DeliveryScope {
  mode: "single" | "all";
  ids: string[];
}

export interface LoadedDeliveryProfileInfo {
  profile_id: string;
  profile_name: string;
  platform: string;
  path: string;
  hash: string;
  aspect_ratio: string | null;
  resolution_width: number | null;
  resolution_height: number | null;
  fps_mode: string | null;
  caption_mode: string | null;
}

export type RepresentativeBasis =
  | "authored_freeze_frame"
  | "still_image"
  | "trim_hint_center"
  | "selected_peak"
  | "candidate_midpoint"
  | "segment_midpoint"
  | "unavailable";

export interface RepresentativeFramePlan {
  timestamp_us: number | null;
  basis: RepresentativeBasis;
  /** Human-readable explanation of why this timestamp was chosen. */
  basis_detail: string;
  source_asset_id: string | null;
  source_asset_hash: string | null;
}

export interface ResolvedCandidateBinding {
  ref: string;
  resolved: boolean;
  unresolved_reason?: string;
  candidate_id: string | null;
  segment_id: string | null;
  asset_id: string | null;
  src_in_us: number | null;
  src_out_us: number | null;
  role: string | null;
  confidence: number | null;
  media_kind: StoryboardMediaKind;
  quality_flags: string[];
  risks: string[];
  evidence: string[];
  transcript_excerpt: string | null;
  audio_role: string | null;
  speaker_role: string | null;
  trim_hint: {
    source_center_us: number | null;
    recommended_in_us: number | null;
    recommended_out_us: number | null;
    center_source: string | null;
    peak_ref: string | null;
  } | null;
  still_image: { hold_duration_sec: number | null; motion_mode: string | null } | null;
  freeze_frame_hold: { source_time_us: number | null; hold_frames: number | null } | null;
  asset_hash: string | null;
  asset_missing: boolean;
}

/** Framing plan for one beat against one delivery canvas. */
export interface FramingPlan {
  canvas: ResolvedCanvas;
  fit: "crop" | "letterbox" | "pillarbox" | "passthrough" | "unknown";
  /** Cover-crop rect normalized on the source frame; null when not computable. */
  crop_rect: { x: number; y: number; width: number; height: number } | null;
  crop_basis: "registered_visual_intent" | "default_center_cover" | "none";
  note: string;
  /** Frame file (relative to projection dir) used inside the framed canvas. */
  primary_frame_relative_path: string | null;
  /** Overlay geometry normalized to the framed canvas; empty when no policy. */
  safe_overlays: Array<{
    id: string;
    kind: string;
    rect: { x: number; y: number; width: number; height: number };
    label: string;
  }>;
  safe_area_note: string;
}

export interface CompiledClipInfo {
  clip_id: string;
  track_id: string;
  asset_id: string;
  segment_id: string;
  candidate_ref: string | null;
  timeline_in_frame: number;
  timeline_duration_frames: number;
  src_in_us: number;
  src_out_us: number;
  head_trim_us: number | null;
  tail_trim_us: number | null;
  fallback_segment_ids: string[];
  motivation: string | null;
}

export interface BeatCompiledPlacement {
  start_frame: number | null;
  end_frame: number | null;
  compiled_frames: number;
  clip_count: number;
  clips: CompiledClipInfo[];
  gap_before_frames: number | null;
  internal_gap_frames: number;
  overrun_frames: number | null;
}

export interface StoryboardBeat {
  index: number;
  beat_id: string;
  label: string;
  viewer_label: string | null;
  purpose: string | null;
  story_role: string | null;
  required_roles: string[];
  notes: string | null;
  media_kind: StoryboardMediaKind;
  plan_start_frame: number;
  plan_duration_frames: number;
  primary: ResolvedCandidateBinding | null;
  fallbacks: ResolvedCandidateBinding[];
  representative: RepresentativeFramePlan;
  transcript_excerpt: string | null;
  uncertainties: string[];
  warnings: string[];
  invalid_reasons: string[];
  compiled: BeatCompiledPlacement | null;
}

export interface UnassignedClipWarning {
  clip_id: string;
  beat_id: string | null;
  reason: string;
}

export interface UncertaintyItem {
  id: string;
  type: string;
  question: string;
  status: string;
  escalation_required: boolean;
  related_beat_ids: string[];
}

export interface ApprovalIdentity {
  /** Canonical artifact hashes the approval is bound to. */
  artifact_hashes: Record<string, string | null>;
  /** Combined hash of all selected delivery profiles; "source-aspect" when none. */
  delivery_hash: string;
  beat_count: number;
  total_frames: number;
}

export interface ProjectionManifest {
  version: "editorial-storyboard-projection/v1";
  projection_id: string;
  generated_at: string;
  source_mode: StoryboardSourceMode;
  project_id: string;
  project_title: string | null;
  delivery: {
    mode: "single" | "all";
    ids: string[];
    profiles: LoadedDeliveryProfileInfo[];
  };
  inputs: ArtifactInputRecord[];
  artifact_hashes: Record<string, string | null>;
  approval_identity: ApprovalIdentity;
  /** Canonical blueprint-to-timeline trim/crop facts consumed by review Ask payloads. */
  review_diff_summary: { trims: string[]; crops: string[] };
  canvas: ResolvedCanvas;
  fps: { num: number; den: number } | null;
  /** Audience-facing one-line policy summaries for the global summary. */
  policy_summaries: { music: string; dialogue: string; caption: string };
  caption_policy_language: string | null;
  beat_count: number;
  total_frames: number;
  total_frames_basis: "blueprint_target_frames" | "timeline_span_frames";
  /** Sum of timeline clip durations when a compiled timeline was read; else null. */
  compiled_span_frames: number | null;
  /** Timeline reading-track end frame when known; else null. */
  timeline_end_frame: number | null;
  representative_frames: Array<{
    beat_id: string;
    binding_ref: string | null;
    timestamp_us: number | null;
    basis: RepresentativeBasis;
    asset_id: string | null;
    asset_hash: string | null;
    frame_file: string | null;
  }>;
  warnings: string[];
  invalid: string[];
  outputs: string[];
  regenerate_command: string;
  generator: "render-editorial-storyboard";
}

export interface ReviewReceipt {
  version: "editorial-review-receipt/v1";
  projection_id: string;
  approved: boolean;
  decisions: Array<{ beat_id: string; verdict: "ok" | "needs_fix"; note?: string }>;
  bound_artifact_hashes: Record<string, string | null>;
  bound_delivery_hash: string;
  created_at: string;
}

export type ReceiptStatus = "no_receipt" | "valid" | "stale" | "invalid";

export interface StalenessCheckResult {
  status: ProjectionStatus;
  approval_allowed: boolean;
  stale_inputs: Array<{ role: ArtifactRole; path: string; expected_hash: string; actual_hash: string | null }>;
  missing_inputs: Array<{ role: ArtifactRole; path: string }>;
  receipt_status: ReceiptStatus;
  receipt_detail: string;
  regenerate_command: string;
}
