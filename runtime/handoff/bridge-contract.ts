/**
 * Python Bridge Contract — Type definitions for the OTIO Python subprocess bridge.
 *
 * The bridge runs as a child process and communicates via JSON stdin/stdout.
 * This file defines the TypeScript side of the contract only.
 * Actual Python script is Phase 2 deliverable.
 */

// ── OTIO Version Pinning ────────────────────────────────────────────

/** Exact-pinned OTIO version. No floating major/minor allowed. */
export const OTIO_VERSION_PIN = "0.17.0";

/** Bridge protocol version. Bumped when request/response schema changes. */
export const BRIDGE_VERSION = "1.0.0";

/** Default subprocess timeout in milliseconds. No retry on timeout. */
export const BRIDGE_TIMEOUT_MS = 30_000;

// ── Bridge Fingerprint ──────────────────────────────────────────────

export interface BridgeFingerprint {
  bridge_version: string;
  python_version: string;
  opentimelineio_version: string;
  bridge_script_hash: string;
  loaded_adapter_modules: string[];
}

// ── Bridge Command Contract ─────────────────────────────────────────

export type BridgeCommand = "export_otio" | "import_otio" | "normalize_otio";

export interface BridgeRequest {
  request_id: string;
  command: BridgeCommand;
  input_path: string | null;
  output_path: string | null;
  options: Record<string, unknown>;
  expected_bridge_version: string;
}

export interface BridgeErrorContext {
  command: BridgeCommand;
  input_path: string | null;
  output_path: string | null;
}

export interface BridgeErrorPayload {
  message: string;
  request_context?: BridgeErrorContext;
}

export interface BridgeResponse {
  request_id: string;
  ok: boolean;
  bridge: BridgeFingerprint;
  payload_path: string | null;
  warnings: string[];
  error?: BridgeErrorPayload;
}

// ── Bridge Error Contract ───────────────────────────────────────────

export type BridgeErrorCode =
  | "BRIDGE_NOT_FOUND"
  | "PYTHON_NOT_FOUND"
  | "OTIO_IMPORT_FAILED"
  | "TIMEOUT"
  | "NON_ZERO_EXIT"
  | "INVALID_JSON_RESPONSE"
  | "BRIDGE_VERSION_MISMATCH"
  | "OTIO_VERSION_MISMATCH"
  | "PROTOCOL_ERROR";

export class BridgeError extends Error {
  readonly code: BridgeErrorCode;
  readonly stderr: string;
  readonly request: BridgeRequest | null;

  constructor(
    code: BridgeErrorCode,
    message: string,
    stderr: string = "",
    request: BridgeRequest | null = null,
  ) {
    super(`[${code}] ${message}`);
    this.name = "BridgeError";
    this.code = code;
    this.stderr = stderr;
    this.request = request;
  }
}

// ── Fingerprint Mismatch Policy ─────────────────────────────────────

export type FingerprintMismatchSeverity = "ok" | "partial" | "failed";

/**
 * Evaluate fingerprint mismatch between export-time and import-time bridges.
 *
 * Rules (from design doc):
 * - same bridge_version + same exact opentimelineio_version: ok
 * - same bridge_version + patch-only opentimelineio_version diff: partial + review_required
 * - bridge_version diff or OTIO major/minor diff: failed
 */
export function evaluateFingerprintMismatch(
  expected: BridgeFingerprint,
  actual: BridgeFingerprint,
): FingerprintMismatchSeverity {
  // Bridge version difference → failed
  if (expected.bridge_version !== actual.bridge_version) {
    return "failed";
  }

  // Same OTIO version → ok
  if (expected.opentimelineio_version === actual.opentimelineio_version) {
    return "ok";
  }

  // Parse semver-like versions to check major/minor vs patch difference
  const expectedParts = parseSemver(expected.opentimelineio_version);
  const actualParts = parseSemver(actual.opentimelineio_version);

  if (!expectedParts || !actualParts) {
    return "failed";
  }

  // Major or minor difference → failed
  if (
    expectedParts.major !== actualParts.major ||
    expectedParts.minor !== actualParts.minor
  ) {
    return "failed";
  }

  // Patch-only difference → partial
  return "partial";
}

// ── Subprocess Invocation Types ─────────────────────────────────────

export interface BridgeInvocationOptions {
  pythonPath?: string;
  bridgeScriptPath: string;
  timeoutMs?: number;
  cwd?: string;
}

export interface BridgeInvocationResult {
  response: BridgeResponse | null;
  exitCode: number | null;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

// ── NLE Capability Profile Types ────────────────────────────────────

export type SurfaceMode =
  | "verified_roundtrip"
  | "provisional_roundtrip"
  | "report_only"
  | "lossy"
  | "one_way";

export interface SurfaceEntry {
  mode: SurfaceMode;
  tolerance_frames?: number;
  detect_after?: string;
  allowed_types?: string[];
}

export interface NleCapabilityProfile {
  version: number;
  profile_id: string;
  nle: {
    vendor: string;
    product: string;
    version_range: string;
  };
  otio: {
    interchange_format: "otio";
    metadata_namespace: string;
  };
  stable_id: {
    primary_paths: {
      clip: string;
      track: string;
    };
    fallback_paths?: string[];
    require_exact_metadata: boolean;
  };
  surfaces: Record<string, SurfaceEntry>;
  import_policy: {
    provisional_mapping_requires_review: boolean;
    unmapped_edit_requires_review: boolean;
    one_to_many_requires_review: boolean;
  };
}

// ── Handoff Resolution Types ────────────────────────────────────────

export type SourceOfTruthDecision = "engine_render" | "nle_finishing";

export interface HandoffResolution {
  handoff_id: string;
  status: "pending" | "decided";
  source_of_truth_decision?: SourceOfTruthDecision;
  decided_by?: string;
  decided_at?: string;
  basis_report_hashes?: {
    roundtrip_import_report?: string;
    human_revision_diff?: string;
  };
}

// ── Internal Helpers ────────────────────────────────────────────────

function parseSemver(
  version: string,
): { major: number; minor: number; patch: number } | null {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
  };
}
