/**
 * M3.5 Phase 2: Handoff Export Orchestrator
 *
 * Orchestrates the export of an approved timeline.json to OTIO handoff package.
 * Responsibilities:
 * - Gate 8: stable ID validation (all tracks/clips/segments have IDs, no duplicates)
 * - Capability profile resolution (resolve-v1.yaml loading)
 * - timeline.json → OTIO conversion via Python bridge subprocess
 * - handoff_manifest.yaml generation (schema-validated)
 * - source map resolution (clip_id → source file)
 * - export readback validation (OTIO re-read → stable ID retention check)
 * - handoff session directory creation
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import * as child_process from "node:child_process";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { TimelineIR, ClipOutput, TrackOutput } from "../compiler/types.js";
import {
  BRIDGE_VERSION,
  BRIDGE_TIMEOUT_MS,
  BridgeError,
  type BridgeFingerprint,
  type BridgeRequest,
  type BridgeResponse,
  type BridgeInvocationOptions,
  type BridgeInvocationResult,
  type NleCapabilityProfile,
  type SurfaceEntry,
} from "./bridge-contract.js";

// ── Types ──────────────────────────────────────────────────────────

export interface HandoffExportInput {
  projectPath: string;
  projectId: string;
  timelineVersion: string;
  timeline: TimelineIR;
  approvalRecord: {
    status: "clean" | "creative_override";
    approved_by: string;
    approved_at: string;
    artifact_versions?: Record<string, string>;
  };
  profilePath: string;
  sourceMap: SourceMapEntry[];
  pythonPath?: string;
  reviewBundleRef?: { export_manifest_path: string };
}

export interface SourceMapEntry {
  asset_id: string;
  source_locator: string;
  local_source_path?: string;
  relink_required?: boolean;
}

export interface HandoffExportResult {
  handoffId: string;
  sessionDir: string;
  manifestPath: string;
  otioPath: string;
  manifest: HandoffManifest;
  bridgeFingerprint: BridgeFingerprint;
  readbackValid: boolean;
}

export interface HandoffManifest {
  version: 1;
  project_id: string;
  handoff_id: string;
  exported_at: string;
  base_timeline: {
    path: string;
    version: string;
    hash: string;
    sequence: {
      fps_num: number;
      fps_den: number;
      width: number;
      height: number;
    };
  };
  approval_snapshot: {
    status: "clean" | "creative_override";
    approved_by: string;
    approved_at: string;
    artifact_versions?: Record<string, string>;
  };
  review_bundle_ref?: { export_manifest_path: string };
  capability_profile: {
    profile_id: string;
    path?: string;
  };
  bridge: BridgeFingerprint;
  nle_session?: {
    vendor: string;
    product: string;
    expected_version?: string;
    expected_import_options?: Record<string, unknown>;
    expected_export_options?: Record<string, unknown>;
  };
  verified_roundtrip_surfaces?: string[];
  provisional_roundtrip_surfaces?: string[];
  report_only_surfaces?: string[];
  lossy_surfaces?: string[];
  source_map: SourceMapEntry[];
  notes?: string[];
}

// ── Gate 8: Stable ID Validation ───────────────────────────────────

export interface Gate8ValidationError {
  type:
    | "missing_track_id"
    | "duplicate_track_id"
    | "missing_clip_id"
    | "missing_segment_id"
    | "missing_asset_id"
    | "duplicate_clip_id";
  location: string;
  detail: string;
}

export function validateStableIds(timeline: TimelineIR): Gate8ValidationError[] {
  const errors: Gate8ValidationError[] = [];
  const allTrackIds = new Set<string>();
  const allClipIds = new Set<string>();

  function validateTracks(tracks: TrackOutput[], groupName: string) {
    for (let ti = 0; ti < tracks.length; ti++) {
      const track = tracks[ti];
      const trackLoc = `${groupName}[${ti}]`;

      // track_id presence
      if (!track.track_id || track.track_id.trim() === "") {
        errors.push({
          type: "missing_track_id",
          location: trackLoc,
          detail: `Track at ${trackLoc} has no track_id`,
        });
      } else {
        // track_id uniqueness within group
        if (allTrackIds.has(track.track_id)) {
          errors.push({
            type: "duplicate_track_id",
            location: trackLoc,
            detail: `Duplicate track_id "${track.track_id}" at ${trackLoc}`,
          });
        }
        allTrackIds.add(track.track_id);
      }

      // clip-level validation
      for (let ci = 0; ci < track.clips.length; ci++) {
        const clip = track.clips[ci];
        const clipLoc = `${trackLoc}.clips[${ci}]`;

        if (!clip.clip_id || clip.clip_id.trim() === "") {
          errors.push({
            type: "missing_clip_id",
            location: clipLoc,
            detail: `Clip at ${clipLoc} has no clip_id`,
          });
        } else {
          if (allClipIds.has(clip.clip_id)) {
            errors.push({
              type: "duplicate_clip_id",
              location: clipLoc,
              detail: `Duplicate clip_id "${clip.clip_id}" at ${clipLoc}`,
            });
          }
          allClipIds.add(clip.clip_id);
        }

        if (!clip.segment_id || clip.segment_id.trim() === "") {
          errors.push({
            type: "missing_segment_id",
            location: clipLoc,
            detail: `Clip at ${clipLoc} has no segment_id`,
          });
        }

        if (!clip.asset_id || clip.asset_id.trim() === "") {
          errors.push({
            type: "missing_asset_id",
            location: clipLoc,
            detail: `Clip at ${clipLoc} has no asset_id`,
          });
        }
      }
    }
  }

  validateTracks(timeline.tracks.video, "video");
  validateTracks(timeline.tracks.audio, "audio");

  return errors;
}

// ── Exchange ID Derivation ─────────────────────────────────────────

export function deriveExchangeClipId(
  projectId: string,
  timelineVersion: string,
  clipId: string,
): string {
  return `${projectId}:${timelineVersion}:${clipId}`;
}

export function deriveExchangeTrackId(
  projectId: string,
  timelineVersion: string,
  trackId: string,
): string {
  return `${projectId}:${timelineVersion}:${trackId}`;
}

// ── Handoff ID Generation ──────────────────────────────────────────

export function generateHandoffId(
  timelineVersion: string,
  timestamp?: string,
): string {
  const ts =
    timestamp ?? new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  return `HND_${timelineVersion}_${ts}`;
}

// ── Capability Profile Loading ─────────────────────────────────────

export function loadCapabilityProfile(
  profilePath: string,
): NleCapabilityProfile {
  const raw = fs.readFileSync(profilePath, "utf-8");
  return parseYaml(raw) as NleCapabilityProfile;
}

export function categorizeSurfaces(profile: NleCapabilityProfile): {
  verified: string[];
  provisional: string[];
  report_only: string[];
  lossy: string[];
  one_way: string[];
} {
  const result = {
    verified: [] as string[],
    provisional: [] as string[],
    report_only: [] as string[],
    lossy: [] as string[],
    one_way: [] as string[],
  };

  for (const [name, entry] of Object.entries(profile.surfaces)) {
    switch (entry.mode) {
      case "verified_roundtrip":
        result.verified.push(name);
        break;
      case "provisional_roundtrip":
        result.provisional.push(name);
        break;
      case "report_only":
        result.report_only.push(name);
        break;
      case "lossy":
        result.lossy.push(name);
        break;
      case "one_way":
        result.one_way.push(name);
        break;
    }
  }

  return result;
}

// ── SHA-256 Hashing ────────────────────────────────────────────────

export function sha256(content: string): string {
  return "sha256:" + crypto.createHash("sha256").update(content, "utf-8").digest("hex");
}

// ── Timeline JSON for Bridge ───────────────────────────────────────

export interface BridgeTimelineInput {
  project_id: string;
  timeline_version: string;
  handoff_id: string;
  capability_profile_id: string;
  approval_status: string;
  sequence: TimelineIR["sequence"];
  tracks: {
    video: BridgeTrackInput[];
    audio: BridgeTrackInput[];
  };
  markers: TimelineIR["markers"];
}

export interface BridgeTrackInput {
  track_id: string;
  exchange_track_id: string;
  kind: string;
  clips: BridgeClipInput[];
}

export interface BridgeClipInput {
  clip_id: string;
  exchange_clip_id: string;
  track_id: string;
  segment_id: string;
  asset_id: string;
  beat_id: string;
  role: string;
  src_in_us: number;
  src_out_us: number;
  timeline_in_frame: number;
  timeline_duration_frames: number;
  source_locator?: string;
  capability_profile_id: string;
}

export function buildBridgeInput(
  input: HandoffExportInput,
): BridgeTimelineInput {
  const { projectId, timelineVersion, timeline } = input;
  const handoffId = generateHandoffId(timelineVersion);
  const profile = loadCapabilityProfile(input.profilePath);
  const sourceLocatorMap = new Map(
    input.sourceMap.map((s) => [s.asset_id, s.source_locator]),
  );

  function mapTrack(t: TrackOutput): BridgeTrackInput {
    return {
      track_id: t.track_id,
      exchange_track_id: deriveExchangeTrackId(projectId, timelineVersion, t.track_id),
      kind: t.kind,
      clips: t.clips.map((c) => ({
        clip_id: c.clip_id,
        exchange_clip_id: deriveExchangeClipId(projectId, timelineVersion, c.clip_id),
        track_id: t.track_id,
        segment_id: c.segment_id,
        asset_id: c.asset_id,
        beat_id: c.beat_id,
        role: c.role,
        src_in_us: c.src_in_us,
        src_out_us: c.src_out_us,
        timeline_in_frame: c.timeline_in_frame,
        timeline_duration_frames: c.timeline_duration_frames,
        source_locator: sourceLocatorMap.get(c.asset_id),
        capability_profile_id: profile.profile_id,
      })),
    };
  }

  return {
    project_id: projectId,
    timeline_version: timelineVersion,
    handoff_id: handoffId,
    capability_profile_id: profile.profile_id,
    approval_status: input.approvalRecord.status,
    sequence: timeline.sequence,
    tracks: {
      video: timeline.tracks.video.map(mapTrack),
      audio: timeline.tracks.audio.map(mapTrack),
    },
    markers: timeline.markers,
  };
}

// ── Python Bridge Invocation ───────────────────────────────────────

export function invokeBridge(
  request: BridgeRequest,
  options: BridgeInvocationOptions,
): BridgeInvocationResult {
  const pythonPath = options.pythonPath ?? "python3";
  const timeoutMs = options.timeoutMs ?? BRIDGE_TIMEOUT_MS;
  const startMs = Date.now();

  if (!fs.existsSync(options.bridgeScriptPath)) {
    throw new BridgeError(
      "BRIDGE_NOT_FOUND",
      `Bridge script not found: ${options.bridgeScriptPath}`,
    );
  }

  try {
    const result = child_process.spawnSync(
      pythonPath,
      [options.bridgeScriptPath],
      {
        input: JSON.stringify(request),
        encoding: "utf-8",
        timeout: timeoutMs,
        cwd: options.cwd,
      },
    );

    const durationMs = Date.now() - startMs;
    const stdout = typeof result.stdout === "string" ? result.stdout : "";

    if (result.error) {
      if ((result.error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new BridgeError(
          "PYTHON_NOT_FOUND",
          `Python not found at: ${pythonPath}`,
          "",
          request,
        );
      }
      if ((result.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
        return {
          response: null,
          exitCode: null,
          stderr: result.stderr ?? "",
          timedOut: true,
          durationMs,
        };
      }
      throw new BridgeError(
        "PROTOCOL_ERROR",
        `Subprocess error: ${result.error.message}`,
        result.stderr ?? "",
        request,
      );
    }

    let response: BridgeResponse | null = null;
    if (stdout.trim() !== "") {
      try {
        response = JSON.parse(stdout) as BridgeResponse;
      } catch {
        if (result.status === 0) {
          throw new BridgeError(
            "INVALID_JSON_RESPONSE",
            `Failed to parse bridge response as JSON`,
            result.stderr ?? "",
            request,
          );
        }
      }
    }

    if (result.status !== 0) {
      return {
        response,
        exitCode: result.status,
        stderr: result.stderr ?? "",
        timedOut: false,
        durationMs,
      };
    }

    if (!response) {
      throw new BridgeError(
        "INVALID_JSON_RESPONSE",
        `Failed to parse bridge response as JSON`,
        result.stderr ?? "",
        request,
      );
    }

    return {
      response,
      exitCode: 0,
      stderr: result.stderr ?? "",
      timedOut: false,
      durationMs,
    };
  } catch (err) {
    if (err instanceof BridgeError) throw err;
    const durationMs = Date.now() - startMs;
    throw new BridgeError(
      "PROTOCOL_ERROR",
      `Unexpected error: ${(err as Error).message}`,
      "",
      request,
    );
  }
}

// ── Build Handoff Manifest ─────────────────────────────────────────

export function buildHandoffManifest(
  input: HandoffExportInput,
  handoffId: string,
  timelineHash: string,
  bridgeFingerprint: BridgeFingerprint,
  profile: NleCapabilityProfile,
  exportedAt: string,
): HandoffManifest {
  const surfaces = categorizeSurfaces(profile);

  const manifest: HandoffManifest = {
    version: 1,
    project_id: input.projectId,
    handoff_id: handoffId,
    exported_at: exportedAt,
    base_timeline: {
      path: "05_timeline/timeline.json",
      version: input.timelineVersion,
      hash: timelineHash,
      sequence: {
        fps_num: input.timeline.sequence.fps_num,
        fps_den: input.timeline.sequence.fps_den,
        width: input.timeline.sequence.width,
        height: input.timeline.sequence.height,
      },
    },
    approval_snapshot: {
      status: input.approvalRecord.status,
      approved_by: input.approvalRecord.approved_by,
      approved_at: input.approvalRecord.approved_at,
      artifact_versions: input.approvalRecord.artifact_versions,
    },
    capability_profile: {
      profile_id: profile.profile_id,
      path: input.profilePath,
    },
    bridge: bridgeFingerprint,
    source_map: input.sourceMap,
  };

  if (input.reviewBundleRef) {
    manifest.review_bundle_ref = input.reviewBundleRef;
  }

  // NLE session from profile
  manifest.nle_session = {
    vendor: profile.nle.vendor,
    product: profile.nle.product,
    expected_version: profile.nle.version_range,
  };

  // Surface categorization
  if (surfaces.verified.length > 0) {
    manifest.verified_roundtrip_surfaces = surfaces.verified;
  }
  if (surfaces.provisional.length > 0) {
    manifest.provisional_roundtrip_surfaces = surfaces.provisional;
  }
  if (surfaces.report_only.length > 0) {
    manifest.report_only_surfaces = surfaces.report_only;
  }
  if (surfaces.lossy.length > 0) {
    manifest.lossy_surfaces = surfaces.lossy;
  }

  manifest.notes = [
    "Imported OTIO must retain video_os.exchange_clip_id metadata.",
    "Unmapped edits require manual review before reuse in engine path.",
  ];

  return manifest;
}

// ── Export Readback Validation ──────────────────────────────────────

export interface ReadbackResult {
  valid: boolean;
  clipCount: number;
  retainedClipIds: string[];
  missingClipIds: string[];
}

/**
 * Validates that an exported OTIO file retains all stable IDs by re-reading
 * it through the bridge and checking exchange_clip_id metadata.
 *
 * If bridge is not available (Python/OTIO not installed), returns a
 * degraded result with valid=false and a note in missingClipIds.
 */
export function validateReadback(
  otioPath: string,
  expectedClipIds: string[],
  bridgeOptions: BridgeInvocationOptions,
): ReadbackResult {
  if (!fs.existsSync(otioPath)) {
    return {
      valid: false,
      clipCount: 0,
      retainedClipIds: [],
      missingClipIds: expectedClipIds,
    };
  }

  // Use the bridge normalize command to re-read the OTIO and extract metadata
  const request: BridgeRequest = {
    request_id: `readback_${Date.now()}`,
    command: "normalize_otio",
    input_path: otioPath,
    output_path: null,
    options: { extract_clip_ids: true },
    expected_bridge_version: BRIDGE_VERSION,
  };

  try {
    const result = invokeBridge(request, bridgeOptions);

    if (!result.response || !result.response.ok) {
      return {
        valid: false,
        clipCount: 0,
        retainedClipIds: [],
        missingClipIds: expectedClipIds,
      };
    }

    // The bridge returns extracted clip IDs in the response payload
    const payload = result.response.payload_path;
    if (!payload) {
      return {
        valid: false,
        clipCount: 0,
        retainedClipIds: [],
        missingClipIds: expectedClipIds,
      };
    }

    const normalizedData = JSON.parse(fs.readFileSync(payload, "utf-8"));
    const extractedIds: string[] = normalizedData.exchange_clip_ids ?? [];

    const retainedClipIds = expectedClipIds.filter((id) =>
      extractedIds.includes(id),
    );
    const missingClipIds = expectedClipIds.filter(
      (id) => !extractedIds.includes(id),
    );

    return {
      valid: missingClipIds.length === 0,
      clipCount: extractedIds.length,
      retainedClipIds,
      missingClipIds,
    };
  } catch {
    return {
      valid: false,
      clipCount: 0,
      retainedClipIds: [],
      missingClipIds: expectedClipIds,
    };
  }
}

// ── Full Export Orchestration ───────────────────────────────────────

export interface ExportError {
  code:
    | "NOT_APPROVED"
    | "GATE_8_FAILED"
    | "PROFILE_NOT_FOUND"
    | "BRIDGE_FAILED"
    | "READBACK_FAILED";
  message: string;
  details?: unknown;
}

export function executeHandoffExport(
  input: HandoffExportInput,
): HandoffExportResult | { error: ExportError } {
  // 1. Gate: approved state (caller should verify, but double-check)
  if (
    input.approvalRecord.status !== "clean" &&
    input.approvalRecord.status !== "creative_override"
  ) {
    return {
      error: {
        code: "NOT_APPROVED",
        message: `Project is not approved. Status: ${input.approvalRecord.status}`,
      },
    };
  }

  // 2. Gate 8: Stable ID Validation
  const gate8Errors = validateStableIds(input.timeline);
  if (gate8Errors.length > 0) {
    return {
      error: {
        code: "GATE_8_FAILED",
        message: `Gate 8 failed: ${gate8Errors.length} stable ID error(s)`,
        details: gate8Errors,
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

  // 4. Generate handoff ID and timestamp
  const exportedAt = new Date().toISOString();
  const handoffId = generateHandoffId(
    input.timelineVersion,
    exportedAt.replace(/[-:]/g, "").replace(/\.\d+/, ""),
  );

  // 5. Create session directory
  const sessionDir = path.join(
    input.projectPath,
    "exports",
    "handoffs",
    handoffId,
  );
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.mkdirSync(path.join(sessionDir, "normalized"), { recursive: true });
  fs.mkdirSync(path.join(sessionDir, "logs"), { recursive: true });

  // 6. Compute timeline hash
  const timelinePath = path.join(input.projectPath, "05_timeline", "timeline.json");
  const timelineContent = fs.existsSync(timelinePath)
    ? fs.readFileSync(timelinePath, "utf-8")
    : JSON.stringify(input.timeline, null, 2);
  const timelineHash = sha256(timelineContent);

  // 7. Build bridge input and write to session dir
  const bridgeInput = buildBridgeInput(input);
  // Override handoff_id with the generated one
  bridgeInput.handoff_id = handoffId;

  const bridgeInputPath = path.join(sessionDir, "bridge_input.json");
  fs.writeFileSync(bridgeInputPath, JSON.stringify(bridgeInput, null, 2), "utf-8");

  // 8. Invoke Python bridge
  const bridgeScriptPath = path.join(
    path.dirname(new URL(import.meta.url).pathname),
    "otio-bridge.py",
  );
  const otioOutputPath = path.join(sessionDir, "handoff_timeline.otio");
  const normalizedOutputPath = path.join(
    sessionDir,
    "normalized",
    "exported_otio.json",
  );

  const bridgeRequest: BridgeRequest = {
    request_id: `export_${handoffId}`,
    command: "export_otio",
    input_path: bridgeInputPath,
    output_path: otioOutputPath,
    options: {
      normalized_output_path: normalizedOutputPath,
    },
    expected_bridge_version: BRIDGE_VERSION,
  };

  let bridgeFingerprint: BridgeFingerprint;

  try {
    const bridgeResult = invokeBridge(bridgeRequest, {
      bridgeScriptPath,
      pythonPath: input.pythonPath,
      cwd: input.projectPath,
    });

    if (bridgeResult.timedOut) {
      return {
        error: {
          code: "BRIDGE_FAILED",
          message: `Bridge timed out after ${BRIDGE_TIMEOUT_MS}ms`,
        },
      };
    }

    if (!bridgeResult.response || !bridgeResult.response.ok) {
      return {
        error: {
          code: "BRIDGE_FAILED",
          message: `Bridge failed: exit=${bridgeResult.exitCode}, stderr=${bridgeResult.stderr}`,
        },
      };
    }

    bridgeFingerprint = bridgeResult.response.bridge;
  } catch (err) {
    return {
      error: {
        code: "BRIDGE_FAILED",
        message: `Bridge error: ${(err as Error).message}`,
      },
    };
  }

  // 9. Build handoff manifest
  const manifest = buildHandoffManifest(
    input,
    handoffId,
    timelineHash,
    bridgeFingerprint,
    profile,
    exportedAt,
  );

  // 10. Write manifest
  const manifestPath = path.join(sessionDir, "handoff_manifest.yaml");
  fs.writeFileSync(manifestPath, stringifyYaml(manifest), "utf-8");

  // 11. Export readback validation
  const allExchangeClipIds = [
    ...input.timeline.tracks.video,
    ...input.timeline.tracks.audio,
  ]
    .flatMap((t) => t.clips)
    .map((c) =>
      deriveExchangeClipId(input.projectId, input.timelineVersion, c.clip_id),
    );

  const readbackResult = validateReadback(otioOutputPath, allExchangeClipIds, {
    bridgeScriptPath,
    pythonPath: input.pythonPath,
    cwd: input.projectPath,
  });

  // 12. Write run log
  const runLog = {
    handoff_id: handoffId,
    exported_at: exportedAt,
    gate_8_passed: true,
    bridge_fingerprint: bridgeFingerprint,
    readback_valid: readbackResult.valid,
    readback_details: readbackResult,
    session_dir: sessionDir,
  };
  fs.writeFileSync(
    path.join(sessionDir, "logs", "handoff_run_log.yaml"),
    stringifyYaml(runLog),
    "utf-8",
  );

  return {
    handoffId,
    sessionDir,
    manifestPath,
    otioPath: otioOutputPath,
    manifest,
    bridgeFingerprint,
    readbackValid: readbackResult.valid,
  };
}
