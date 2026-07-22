/**
 * Audio mixer — combines dialogue stem + optional BGM into final_mix.wav.
 *
 * Per milestone-4-design §Mixer:
 * - No BGM: pass-through mastering of dialogue only
 * - With BGM: apply ducking to BGM, mix with dialogue, then master
 * - Speech intervals extracted from A1 clips
 */

import { execFile } from "node:child_process";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";
import type { MusicCuesDoc } from "./music-cues.js";
import type { SpeechInterval } from "./ducking.js";
import { buildFadeFilter } from "./ducking.js";
import {
  DEFAULT_MASTERING,
  masterAudio,
  type LoudnormMeasurement,
  type MasteringDefaults,
} from "./mastering.js";

// ── Types ──────────────────────────────────────────────────────────

export interface MixOptions {
  rawDialoguePath: string;
  bgmPath?: string;
  musicCues?: MusicCuesDoc;
  speechIntervals: SpeechInterval[];
  fps: number;
  outputPath: string;
  masteringDefaults?: MasteringDefaults;
}

export interface AudioMixReport {
  version: "audio-mix-report/v1";
  has_bgm: boolean;
  strategy:
    | "dialogue_only_mastering_v1"
    | "waveform_sidechain_v1"
    | "timeline_embedded_bgm_mastering_v1";
  bgm_ownership?: {
    owner: "timeline_assembler";
    asset_ids: string[];
  };
  final_mastering: {
    loudness_target_lufs: number;
    lra_target: number;
    true_peak_target_dbtp: number;
    premaster_measurement: LoudnormMeasurement;
  };
  bgm_reference_mastering?: {
    loudness_target_lufs: number;
    lra_target: number;
    true_peak_target_dbtp: number;
    source_measurement: LoudnormMeasurement;
  };
  sidechain?: {
    detector: "dialogue_waveform_rms";
    threshold: number;
    ratio: number;
    attack_ms: number;
    release_ms: number;
    base_gain_db: number;
    requested_duck_gain_db: number;
  };
}

/** Normalize every library/source track before applying editorial gain. */
export const BGM_REFERENCE_MASTERING: MasteringDefaults = {
  loudness_target_lufs: -23,
  lra_target: 7,
  true_peak_target_dbtp: -2,
};

const SIDECHAIN_THRESHOLD = 0.03;

// ── Helpers ────────────────────────────────────────────────────────

function execFfmpeg(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      "ffmpeg",
      args,
      { maxBuffer: 50 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(err);
          return;
        }
        resolve({ stdout: stdout ?? "", stderr: stderr ?? "" });
      },
    );
  });
}

/**
 * Create a unique temporary file path.
 */
function tmpPath(suffix: string): string {
  const dir = os.tmpdir();
  const id = `vos_mix_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  return path.join(dir, `${id}${suffix}`);
}

// ── Speech Interval Extraction ─────────────────────────────────────

/**
 * Extract speech intervals from timeline A1 clips.
 *
 * Converts timeline_in_frame / timeline_duration_frames to milliseconds
 * using the given fps.
 */
export function extractSpeechIntervals(
  a1Clips: Array<{ timeline_in_frame: number; timeline_duration_frames: number }>,
  fps: number,
): SpeechInterval[] {
  const msPerFrame = 1000 / fps;
  return a1Clips.map((clip) => ({
    start_ms: clip.timeline_in_frame * msPerFrame,
    end_ms: (clip.timeline_in_frame + clip.timeline_duration_frames) * msPerFrame,
  }));
}

// ── Mixer ──────────────────────────────────────────────────────────

/**
 * Mix dialogue + optional BGM into final_mix.wav.
 *
 * If no BGM path is provided, the dialogue is mastered directly.
 * If BGM is provided:
 * 1. Apply ducking filter to BGM (reduces volume during speech)
 * 2. Apply fade in/out to BGM
 * 3. Mix BGM with dialogue using amix
 * 4. Master the mixed output
 */
export async function mixAudio(opts: MixOptions): Promise<{
  outputPath: string;
  hasBgm: boolean;
  report: AudioMixReport;
}> {
  const {
    rawDialoguePath,
    bgmPath,
    musicCues,
    speechIntervals,
    fps,
    outputPath,
    masteringDefaults,
  } = opts;

  // No BGM: pass-through mastering of dialogue only
  if (!bgmPath) {
    const defaults = masteringDefaults ?? DEFAULT_MASTERING;
    const mastered = await masterAudio(rawDialoguePath, outputPath, defaults);
    return {
      outputPath,
      hasBgm: false,
      report: {
        version: "audio-mix-report/v1",
        has_bgm: false,
        strategy: "dialogue_only_mastering_v1",
        final_mastering: {
          ...defaults,
          premaster_measurement: mastered.measurement,
        },
      },
    };
  }

  // With BGM: apply ducking, mix, then master
  const tmpMixed = tmpPath(".wav");
  const tmpNormalizedBgm = tmpPath(".wav");

  try {
    // Editorial gain must not depend on whether a library master arrived at
    // -15 LUFS or -24 LUFS. Pin the bed to one reference before ducking.
    const bgmMaster = await masterAudio(
      bgmPath,
      tmpNormalizedBgm,
      BGM_REFERENCE_MASTERING,
    );

    // Build the BGM filter chain
    const bgmFilters: string[] = [];
    let cue = musicCues?.cues[0];

    if (cue) {
      bgmFilters.push(`volume=${cue.ducking.base_gain_db}dB`);

      // Apply fade in/out
      const durationFrames = cue.exit_frame - cue.entry_frame;
      const durationMs = (durationFrames / fps) * 1000;
      const fadeFilter = buildFadeFilter(cue.fade_in_ms, cue.fade_out_ms, durationMs);
      if (fadeFilter) {
        bgmFilters.push(fadeFilter);
      }
    }

    // Build ffmpeg command: mix dialogue + ducked BGM
    // Keep speechIntervals in the public input for compatibility and timeline
    // diagnostics, but never use A1 clip occupancy as the ducking detector.
    // Edit clips commonly span breaths and pauses; the waveform is the truth.
    void speechIntervals;
    const filterComplex = buildMixFilterComplex(bgmFilters, cue);

    await execFfmpeg([
      "-y",
      "-i", rawDialoguePath,
      "-i", tmpNormalizedBgm,
      "-filter_complex", filterComplex,
      "-ac", "1",
      "-ar", "48000",
      tmpMixed,
    ]);

    // Master the mixed output
    const defaults = masteringDefaults ?? DEFAULT_MASTERING;
    const finalMaster = await masterAudio(tmpMixed, outputPath, defaults);
    const sidechain = cue ? buildSidechainReport(cue) : undefined;

    return {
      outputPath,
      hasBgm: true,
      report: {
        version: "audio-mix-report/v1",
        has_bgm: true,
        strategy: "waveform_sidechain_v1",
        final_mastering: {
          ...defaults,
          premaster_measurement: finalMaster.measurement,
        },
        bgm_reference_mastering: {
          ...BGM_REFERENCE_MASTERING,
          source_measurement: bgmMaster.measurement,
        },
        ...(sidechain ? { sidechain } : {}),
      },
    };
  } finally {
    // Clean up temp file
    try {
      fs.unlinkSync(tmpMixed);
    } catch {
      // Ignore cleanup errors
    }
    try {
      fs.unlinkSync(tmpNormalizedBgm);
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Build the filter_complex string for mixing dialogue (input 0)
 * with BGM (input 1) that has ducking/fade filters applied.
 */
function buildMixFilterComplex(
  bgmFilters: string[],
  cue: MusicCuesDoc["cues"][number] | undefined,
): string {
  const bgmChain = bgmFilters.length > 0 ? bgmFilters.join(",") : "anull";
  if (!cue) {
    return `[1:a]${bgmChain}[bgm];[0:a][bgm]amix=inputs=2:duration=first:dropout_transition=0:normalize=0`;
  }

  // A1 edit clips often cover the whole timeline, including breaths and
  // pauses. Use the actual dialogue waveform as the sidechain so the bed
  // releases naturally between spoken phrases instead of staying permanently
  // ducked. The requested base/duck delta controls compressor strength.
  const duckDepthDb = Math.max(0, cue.ducking.base_gain_db - cue.ducking.duck_gain_db);
  const ratio = Math.min(20, Math.max(2, 1 + duckDepthDb * 1.5));
  return [
    `[1:a]${bgmChain}[bed]`,
    `[bed][0:a]sidechaincompress=threshold=${SIDECHAIN_THRESHOLD}:ratio=${ratio.toFixed(2)}`
      + `:attack=${cue.ducking.attack_ms}:release=${cue.ducking.release_ms}`
      + ":knee=2.8:detection=rms[bgm]",
    "[0:a][bgm]amix=inputs=2:duration=first:dropout_transition=0:normalize=0",
  ].join(";");
}

function buildSidechainReport(
  cue: MusicCuesDoc["cues"][number],
): NonNullable<AudioMixReport["sidechain"]> {
  const duckDepthDb = Math.max(0, cue.ducking.base_gain_db - cue.ducking.duck_gain_db);
  const ratio = Math.min(20, Math.max(2, 1 + duckDepthDb * 1.5));
  return {
    detector: "dialogue_waveform_rms",
    threshold: SIDECHAIN_THRESHOLD,
    ratio: Number(ratio.toFixed(2)),
    attack_ms: cue.ducking.attack_ms,
    release_ms: cue.ducking.release_ms,
    base_gain_db: cue.ducking.base_gain_db,
    requested_duck_gain_db: cue.ducking.duck_gain_db,
  };
}
