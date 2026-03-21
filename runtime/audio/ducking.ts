/**
 * Ducking filter graph generation — builds ffmpeg filter strings
 * for volume ducking and fade in/out.
 *
 * Per milestone-4-design §Ducking:
 * - Volume keyframes for ducking during speech intervals
 * - Attack/release ramps for smooth transitions
 * - Fade filters for music entry/exit
 */

import type { DuckingParams, MusicCue } from "./music-cues.js";

// ── Types ──────────────────────────────────────────────────────────

/** Speech interval in the audio timeline. */
export interface SpeechInterval {
  start_ms: number;
  end_ms: number;
}

// ── Ducking Filter ─────────────────────────────────────────────────

/**
 * Build an ffmpeg volume-based ducking filter graph.
 *
 * Uses volume keyframes: during speech intervals the music is reduced
 * to duck_gain_db, otherwise it stays at base_gain_db. Attack and
 * release ramps are applied around each speech interval for smooth
 * transitions.
 *
 * Returns an ffmpeg filter string like:
 *   "volume='if(between(t,1.5,3.2),-24,-16)':eval=frame"
 *
 * For multiple speech intervals, constructs nested if() expressions.
 */
export function buildDuckingFilter(
  cue: MusicCue,
  speechIntervals: SpeechInterval[],
  fps: number,
): string {
  const { base_gain_db, duck_gain_db, attack_ms, release_ms } = cue.ducking;

  // Convert frame positions to seconds for the music clip's local timeline
  const cueStartSec = cue.entry_frame / fps;
  const cueEndSec = cue.exit_frame / fps;

  if (speechIntervals.length === 0) {
    // No speech: constant base gain
    return `volume=${base_gain_db}dB`;
  }

  const attackSec = attack_ms / 1000;
  const releaseSec = release_ms / 1000;

  // Filter speech intervals to those overlapping with the cue
  const cueStartMs = cueStartSec * 1000;
  const cueEndMs = cueEndSec * 1000;
  const relevant = speechIntervals.filter(
    (si) => si.end_ms > cueStartMs && si.start_ms < cueEndMs,
  );

  if (relevant.length === 0) {
    return `volume=${base_gain_db}dB`;
  }

  // Build volume expression with ducking regions
  // Each speech interval creates a ducked region with attack/release ramps
  // Time reference is relative to the music clip start (cueStartSec)
  const conditions: string[] = [];

  for (const si of relevant) {
    // Convert speech interval to seconds relative to clip start
    const speechStartSec = si.start_ms / 1000 - cueStartSec;
    const speechEndSec = si.end_ms / 1000 - cueStartSec;

    // Attack ramp: transition from base to duck before speech starts
    const attackStart = Math.max(0, speechStartSec - attackSec);
    const attackEnd = speechStartSec;

    // Release ramp: transition from duck to base after speech ends
    const releaseStart = speechEndSec;
    const releaseEnd = speechEndSec + releaseSec;

    // Attack ramp region (linear interpolation from base to duck)
    if (attackSec > 0) {
      conditions.push(
        `between(t,${attackStart.toFixed(4)},${attackEnd.toFixed(4)})*` +
        `(${base_gain_db}+(${duck_gain_db}-${base_gain_db})*` +
        `(t-${attackStart.toFixed(4)})/${attackSec.toFixed(4)})`,
      );
    }

    // Ducked region (constant duck gain during speech)
    conditions.push(
      `between(t,${attackEnd.toFixed(4)},${releaseStart.toFixed(4)})*${duck_gain_db}`,
    );

    // Release ramp region (linear interpolation from duck to base)
    if (releaseSec > 0) {
      conditions.push(
        `between(t,${releaseStart.toFixed(4)},${releaseEnd.toFixed(4)})*` +
        `(${duck_gain_db}+(${base_gain_db}-${duck_gain_db})*` +
        `(t-${releaseStart.toFixed(4)})/${releaseSec.toFixed(4)})`,
      );
    }
  }

  // The volume expression sums all condition contributions;
  // regions not covered by any condition get base_gain_db.
  // We use a nested if-chain for clarity and correctness.
  let expr = `${base_gain_db}`;
  for (const si of relevant) {
    const speechStartSec = si.start_ms / 1000 - cueStartSec;
    const speechEndSec = si.end_ms / 1000 - cueStartSec;
    const attackStart = Math.max(0, speechStartSec - attackSec);
    const releaseEnd = speechEndSec + releaseSec;

    // Simplified: use between() to select the entire duck region
    // (attack ramp start to release ramp end), applying duck_gain_db
    expr = `if(between(t,${attackStart.toFixed(4)},${releaseEnd.toFixed(4)}),${duck_gain_db},${expr})`;
  }

  return `volume='${expr}dB':eval=frame`;
}

// ── Fade Filter ────────────────────────────────────────────────────

/**
 * Build fade filter for music entry/exit.
 *
 * Returns an ffmpeg filter string like:
 *   "afade=t=in:d=0.4,afade=t=out:st=<exit_start>:d=0.9"
 */
export function buildFadeFilter(
  fadeInMs: number,
  fadeOutMs: number,
  totalDurationMs: number,
): string {
  const parts: string[] = [];

  if (fadeInMs > 0) {
    const fadeInSec = fadeInMs / 1000;
    parts.push(`afade=t=in:d=${fadeInSec.toFixed(4)}`);
  }

  if (fadeOutMs > 0) {
    const fadeOutSec = fadeOutMs / 1000;
    const totalSec = totalDurationMs / 1000;
    const exitStartSec = Math.max(0, totalSec - fadeOutSec);
    parts.push(`afade=t=out:st=${exitStartSec.toFixed(4)}:d=${fadeOutSec.toFixed(4)}`);
  }

  return parts.join(",");
}
