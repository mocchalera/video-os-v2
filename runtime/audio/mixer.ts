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
import { buildDuckingFilter, buildFadeFilter } from "./ducking.js";
import { masterAudio, type MasteringDefaults } from "./mastering.js";

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
    await masterAudio(rawDialoguePath, outputPath, masteringDefaults);
    return { outputPath, hasBgm: false };
  }

  // With BGM: apply ducking, mix, then master
  const tmpMixed = tmpPath(".wav");

  try {
    // Build the BGM filter chain
    const bgmFilters: string[] = [];

    // Apply ducking if music cues are provided
    if (musicCues && musicCues.cues.length > 0) {
      const cue = musicCues.cues[0];
      const duckFilter = buildDuckingFilter(cue, speechIntervals, fps);
      if (duckFilter) {
        bgmFilters.push(duckFilter);
      }

      // Apply fade in/out
      const durationFrames = cue.exit_frame - cue.entry_frame;
      const durationMs = (durationFrames / fps) * 1000;
      const fadeFilter = buildFadeFilter(cue.fade_in_ms, cue.fade_out_ms, durationMs);
      if (fadeFilter) {
        bgmFilters.push(fadeFilter);
      }
    }

    // Build ffmpeg command: mix dialogue + ducked BGM
    const filterComplex = buildMixFilterComplex(bgmFilters);

    await execFfmpeg([
      "-y",
      "-i", rawDialoguePath,
      "-i", bgmPath,
      "-filter_complex", filterComplex,
      "-ac", "1",
      "-ar", "48000",
      tmpMixed,
    ]);

    // Master the mixed output
    await masterAudio(tmpMixed, outputPath, masteringDefaults);

    return { outputPath, hasBgm: true };
  } finally {
    // Clean up temp file
    try {
      fs.unlinkSync(tmpMixed);
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Build the filter_complex string for mixing dialogue (input 0)
 * with BGM (input 1) that has ducking/fade filters applied.
 */
function buildMixFilterComplex(bgmFilters: string[]): string {
  // Apply filters to BGM stream (input 1), then mix with dialogue (input 0)
  if (bgmFilters.length > 0) {
    const bgmChain = bgmFilters.join(",");
    return `[1:a]${bgmChain}[bgm];[0:a][bgm]amix=inputs=2:duration=longest:dropout_transition=2`;
  }

  // No filters on BGM, just mix directly
  return "[0:a][1:a]amix=inputs=2:duration=longest:dropout_transition=2";
}
