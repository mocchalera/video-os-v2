import * as fs from "node:fs";
import {
  BRIDGE_VERSION,
  type BridgeFingerprint,
  type BridgeRequest,
} from "../bridge-contract.js";
import {
  invokeBridge,
} from "../export.js";
import type { NormalizedClip } from "./index.js";

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

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

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

    const normalized = JSON.parse(fs.readFileSync(payloadPath, "utf-8")) as Record<string, unknown>;
    const rawClips = Array.isArray(normalized.clips) ? normalized.clips : [];
    const clips: NormalizedClip[] = rawClips.map((clip: unknown) => {
      const item = clip as Record<string, unknown>;
      return {
        exchange_clip_id: (item.exchange_clip_id as string) ?? "",
        clip_id: (item.clip_id as string) ?? "",
        track_id: (item.track_id as string) ?? "",
        asset_id: (item.asset_id as string) ?? "",
        segment_id: (item.segment_id as string) ?? "",
        src_in_us: (item.src_in_us as number) ?? 0,
        src_out_us: (item.src_out_us as number) ?? 0,
        timeline_in_frame: (item.timeline_in_frame as number) ?? 0,
        timeline_duration_frames: (item.timeline_duration_frames as number) ?? 0,
        name: typeof item.name === "string" ? item.name : undefined,
        enabled: typeof item.enabled === "boolean" ? item.enabled : undefined,
        metadata_lost: item.metadata_lost === true,
        track_kind: typeof item.track_kind === "string" ? item.track_kind : undefined,
        vendor_metadata_keys: normalizeStringArray(item.vendor_metadata_keys),
        track_vendor_metadata_keys: normalizeStringArray(item.track_vendor_metadata_keys),
        unknown_property_keys: normalizeStringArray(item.unknown_property_keys),
        track_unknown_property_keys: normalizeStringArray(item.track_unknown_property_keys),
        effect_names: normalizeStringArray(item.effect_names),
      };
    });

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
