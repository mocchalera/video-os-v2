/**
 * Pyannote Speaker Diarization Connector — TypeScript wrapper for pyannote-bridge.py.
 *
 * Calls the Python bridge script via child_process stdin/stdout JSON protocol.
 * Same pattern as runtime/handoff/bridge-contract.ts + otio-bridge.py.
 *
 * Provides graceful fallback when pyannote is not installed —
 * diarizeAsset() returns an empty array and logs a warning.
 */

import { execFile } from "node:child_process";
import * as path from "node:path";

// ── Types ──────────────────────────────────────────────────────────

/** A single speaker turn from pyannote diarization. */
export interface DiarizeTurn {
  /** Speaker label from pyannote (e.g. "SPEAKER_00", "SPEAKER_01") */
  speaker_id: string;
  /** Start time in microseconds */
  start_us: number;
  /** End time in microseconds */
  end_us: number;
}

/** Options for diarization. */
export interface DiarizeOptions {
  /** Minimum expected number of speakers */
  minSpeakers?: number;
  /** Maximum expected number of speakers */
  maxSpeakers?: number;
  /** Hugging Face token (falls back to HF_TOKEN env var in Python) */
  hfToken?: string;
  /** pyannote model name (default: pyannote/speaker-diarization-3.1) */
  model?: string;
  /** Device for inference (e.g. "cpu", "cuda", "mps") */
  device?: string;
  /** Timeout in milliseconds (default: 300_000 = 5 minutes) */
  timeoutMs?: number;
}

/** Raw response from the Python bridge. */
interface BridgeResponse {
  ok: boolean;
  bridge_version: string;
  python_version: string;
  warnings: string[];
  payload?: {
    turns: Array<{
      speaker_id: string;
      start: number; // seconds
      end: number;   // seconds
    }>;
  };
  error?: string;
}

// ── Constants ──────────────────────────────────────────────────────

const BRIDGE_SCRIPT = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  "pyannote-bridge.py",
);

const DEFAULT_TIMEOUT_MS = 300_000; // 5 minutes

export const DIARIZER_CONNECTOR_VERSION = "pyannote-diarizer-v1.0.0";

// ── Bridge Invocation ──────────────────────────────────────────────

/**
 * Call the Python bridge script with a JSON request via stdin.
 * Returns the parsed JSON response from stdout.
 */
function callBridge(request: Record<string, unknown>, timeoutMs: number): Promise<BridgeResponse> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "python3",
      [BRIDGE_SCRIPT],
      {
        maxBuffer: 10 * 1024 * 1024,
        timeout: timeoutMs,
      },
      (err, stdout, stderr) => {
        if (err) {
          // Check for common failure modes
          if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            reject(new Error("python3 not found in PATH"));
            return;
          }
          if (stderr && stderr.includes("ModuleNotFoundError")) {
            reject(new Error("pyannote.audio not installed"));
            return;
          }
          reject(new Error(`pyannote bridge error: ${err.message}${stderr ? `\nstderr: ${stderr}` : ""}`));
          return;
        }

        try {
          const response = JSON.parse(stdout) as BridgeResponse;
          resolve(response);
        } catch {
          reject(new Error(`Invalid JSON from pyannote bridge: ${stdout.slice(0, 500)}`));
        }
      },
    );

    // Send request via stdin
    child.stdin?.write(JSON.stringify(request));
    child.stdin?.end();
  });
}

// ── Public API ─────────────────────────────────────────────────────

/**
 * Check if pyannote diarization is available (python3 + pyannote.audio installed).
 * Returns { available: true } or { available: false, reason: string }.
 */
export async function checkDiarizationAvailable(): Promise<{
  available: boolean;
  reason?: string;
}> {
  try {
    const response = await callBridge({ action: "check" }, 10_000);
    if (response.ok) {
      return { available: true };
    }
    return { available: false, reason: response.error ?? "unknown" };
  } catch (err) {
    return {
      available: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Run pyannote speaker diarization on an audio file.
 *
 * Returns an array of DiarizeTurn (speaker_id + microsecond timings).
 * On failure (pyannote not installed, HF_TOKEN missing, etc.),
 * returns an empty array and logs a warning — never throws.
 */
export async function diarizeAsset(
  audioPath: string,
  options: DiarizeOptions = {},
): Promise<DiarizeTurn[]> {
  const request: Record<string, unknown> = {
    action: "diarize",
    audio_path: audioPath,
  };

  if (options.minSpeakers != null) request.min_speakers = options.minSpeakers;
  if (options.maxSpeakers != null) request.max_speakers = options.maxSpeakers;
  if (options.hfToken) request.hf_token = options.hfToken;
  if (options.model) request.model = options.model;
  if (options.device) request.device = options.device;

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  try {
    const response = await callBridge(request, timeoutMs);

    if (response.warnings.length > 0) {
      console.warn(`[pyannote] Warnings: ${response.warnings.join("; ")}`);
    }

    if (!response.ok) {
      console.warn(`[pyannote] Diarization failed: ${response.error ?? "unknown error"}`);
      return [];
    }

    if (!response.payload?.turns) {
      console.warn("[pyannote] No turns in response payload");
      return [];
    }

    // Convert seconds → microseconds
    return response.payload.turns
      .filter((t) => t.end > t.start)
      .map((t) => ({
        speaker_id: t.speaker_id,
        start_us: Math.round(t.start * 1_000_000),
        end_us: Math.round(t.end * 1_000_000),
      }));
  } catch (err) {
    console.warn(
      `[pyannote] Diarization unavailable: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}
