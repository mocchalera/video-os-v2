/** Read-only BGM pack contracts shared by the registry, catalog, and CLI. */

export const BGM_PACK_ERROR_CODES = [
  "BGM_PACK_NOT_FOUND",
  "BGM_PACK_BUSY",
  "BGM_PACK_INCOMPATIBLE",
  "BGM_PACK_ARCHIVE_UNSAFE",
  "BGM_PACK_MEMBER_UNSUPPORTED",
  "BGM_PACK_SIZE_LIMIT",
  "BGM_PACK_HASH_MISMATCH",
  "BGM_TRACK_MISSING",
  "BGM_TRACK_HASH_MISMATCH",
  "BGM_RIGHTS_BLOCKED",
  "BGM_ANALYSIS_UNAVAILABLE",
  "BGM_SELECTION_INCONCLUSIVE",
  "BGM_ARRANGEMENT_NO_SAFE_FIT",
  "BGM_RENDER_PLAN_STALE",
] as const;

export type BgmPackErrorCode = (typeof BGM_PACK_ERROR_CODES)[number];
export type BgmPackIssueSeverity = "error" | "warning";

export interface BgmPackIssue {
  code: BgmPackErrorCode;
  message: string;
  recoverable: boolean;
  affected_ref?: string;
  suggested_action: string;
  severity: BgmPackIssueSeverity;
}

export const SUPPORTED_BGM_AUDIO_FORMATS = [
  "wav",
  "flac",
  "aiff",
  "mp3",
  "m4a",
  "ogg",
] as const;

export type BgmAudioFormat = (typeof SUPPORTED_BGM_AUDIO_FORMATS)[number];

export interface BgmPackAssetRef {
  path: string;
  content_hash: string;
  size_bytes: number;
  format: BgmAudioFormat;
}

export interface BgmPackDataRef {
  path: string;
  content_hash: string;
  size_bytes: number;
  format: "json" | "yaml";
}

export interface BgmAlternateMix extends BgmPackAssetRef {
  mix_id: string;
}

export interface BgmStem extends BgmPackAssetRef {
  stem_id: string;
}

export interface BgmEditorialAxis {
  value: number;
  source: "authored";
}

export interface BgmPackTrack {
  track_id: string;
  title: string;
  contributor_id: string;
  duration_us: number;
  format: BgmAudioFormat;
  full_mix: BgmPackAssetRef;
  preview: BgmPackAssetRef;
  alternate_mixes?: BgmAlternateMix[];
  stems?: BgmStem[];
  rights_ref: BgmPackDataRef;
  analysis_ref: BgmPackDataRef;
  family: string;
  intensity: "low" | "high";
  use_cases: string[];
  exclusions: string[];
  instruments: string[];
  edit_points_us: number[];
  loop_windows: Array<{ in_us: number; out_us: number; max_repetitions?: number }>;
  axes: Record<string, BgmEditorialAxis>;
  vocal_presence: "none" | "texture" | "lead" | "unknown";
}

export interface BgmPackManifest {
  version: string;
  pack_id: string;
  pack_version: string;
  title: string;
  created_at: string;
  catalog_license: string;
  default_content_license: string;
  compatible_video_os: {
    contract_min: string;
    contract_max: string;
  };
  tracks: BgmPackTrack[];
  provenance: {
    producer: string;
    source_type: "bundled_pack" | "user_library" | "project_local";
    evidence_refs: string[];
    evidence_assets?: BgmPackDataRef[];
  };
  hash_policy: {
    algorithm: "sha256";
    canonicalization: "normalized-json-v1";
    excluded_fields: string[];
  };
}

export type BgmPackSource = "project_override" | "environment" | "user" | "bundled";

export interface PackVerification {
  ok: boolean;
  pack_ref: string;
  manifest?: BgmPackManifest;
  manifest_hash?: string;
  files_checked: number;
  bytes_checked: number;
  issues: BgmPackIssue[];
  manifest_state: "valid" | "schema_invalid" | "unreadable" | "missing";
  verified_assets?: Record<string, VerifiedTrackAssets>;
  verified_provenance_paths?: string[];
}

export interface VerifiedTrackAssets {
  full_mix_path?: string;
  preview_path?: string;
  alternate_mix_paths: Record<string, string>;
  stem_paths: Record<string, string>;
  rights_path?: string;
  analysis_path?: string;
}

export interface InstalledBgmPack {
  source: BgmPackSource;
  priority: number;
  pack_path: string;
  manifest_path: string;
  manifest: BgmPackManifest;
  manifest_hash: string;
  verification: PackVerification;
}

export interface CatalogTrack {
  pack_id: string;
  pack_version: string;
  pack_source: BgmPackSource;
  manifest_hash: string;
  track: BgmPackTrack;
  full_mix_path: string;
  preview_path: string;
}

export interface BgmCatalog {
  packs: InstalledBgmPack[];
  tracks: CatalogTrack[];
  warnings: BgmPackIssue[];
}

export interface BgmPackRegistryResult {
  packs: InstalledBgmPack[];
  issues: BgmPackIssue[];
  blocked_pack_ids: string[];
  global_fallback_blocked: boolean;
}

export interface BgmTrackFilters {
  family?: string;
  intensity?: "low" | "high";
  use_case?: string;
  vocal_presence?: BgmPackTrack["vocal_presence"];
}

export interface ResolvedBgmTrack {
  ok: boolean;
  track?: CatalogTrack;
  issues: BgmPackIssue[];
}

export function packIssue(
  code: BgmPackErrorCode,
  message: string,
  options: {
    recoverable?: boolean;
    affectedRef?: string;
    suggestedAction: string;
    severity?: BgmPackIssueSeverity;
  },
): BgmPackIssue {
  return {
    code,
    message,
    recoverable: options.recoverable ?? true,
    ...(options.affectedRef ? { affected_ref: options.affectedRef } : {}),
    suggested_action: options.suggestedAction,
    severity: options.severity ?? "error",
  };
}

export function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/i.test(value);
}
