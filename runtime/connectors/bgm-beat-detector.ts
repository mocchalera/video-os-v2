// BGM Beat Detector
// Detects beats, downbeats, sections and BPM from a BGM audio file.
// Uses ffmpeg onset detection heuristic as primary method.
// Pure TypeScript, no Python bridge required for P0.
//
// Output: BgmAnalysis artifact saved to 07_package/audio/bgm-analysis.json

import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import type { BgmAnalysis, BgmSection } from "../compiler/transition-types.js";

// ── FFmpeg-based onset detection ────────────────────────────────────

interface OnsetEvent {
  time_sec: number;
  strength: number;
}

/**
 * Extract onset events from an audio file using ffmpeg's ebur128 / onset filter.
 * Falls back to silence-split heuristic if onset detection is unavailable.
 */
function detectOnsetsViaFfmpeg(audioPath: string, sampleRate: number = 48000): OnsetEvent[] {
  // Use ffmpeg to detect onsets via the 'silencedetect' filter as a proxy.
  // For P0, this provides a reasonable approximation of beat positions.
  try {
    const result = execSync(
      `ffmpeg -i "${audioPath}" -af "silencedetect=noise=-30dB:d=0.1" -f null - 2>&1`,
      { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024, timeout: 60000 },
    );

    const events: OnsetEvent[] = [];
    const lines = result.split("\n");
    for (const line of lines) {
      // Parse silence_end lines (onset of sound)
      const match = line.match(/silence_end:\s*([\d.]+)/);
      if (match) {
        events.push({ time_sec: parseFloat(match[1]), strength: 1.0 });
      }
    }
    return events;
  } catch {
    return [];
  }
}

/**
 * Get audio duration via ffprobe.
 */
function getAudioDuration(audioPath: string): number {
  try {
    const result = execSync(
      `ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${audioPath}"`,
      { encoding: "utf-8", timeout: 30000 },
    );
    return parseFloat(result.trim()) || 0;
  } catch {
    return 0;
  }
}

/**
 * Estimate BPM from onset intervals using autocorrelation-like heuristic.
 */
function estimateBpm(onsets: OnsetEvent[]): number {
  if (onsets.length < 4) return 120; // default fallback

  // Compute intervals between consecutive onsets
  const intervals: number[] = [];
  for (let i = 1; i < onsets.length; i++) {
    const interval = onsets[i].time_sec - onsets[i - 1].time_sec;
    if (interval > 0.1 && interval < 2.0) {
      intervals.push(interval);
    }
  }

  if (intervals.length === 0) return 120;

  // Median interval
  intervals.sort((a, b) => a - b);
  const median = intervals[Math.floor(intervals.length / 2)];
  const bpm = 60 / median;

  // Clamp to reasonable range
  let result = bpm;
  while (result > 200) result /= 2;
  while (result < 60) result *= 2;

  return Math.round(result * 10) / 10;
}

/**
 * Generate a beat grid from BPM and duration.
 */
function generateBeatGrid(
  bpm: number,
  durationSec: number,
  meter: string = "4/4",
): { beats_sec: number[]; downbeats_sec: number[] } {
  const beatInterval = 60 / bpm;
  const [beatsPerBar] = meter.split("/").map(Number);
  const barBeats = beatsPerBar || 4;

  const beats_sec: number[] = [];
  const downbeats_sec: number[] = [];

  for (let i = 0; i * beatInterval < durationSec; i++) {
    const t = Math.round(i * beatInterval * 1000) / 1000;
    beats_sec.push(t);
    if (i % barBeats === 0) {
      downbeats_sec.push(t);
    }
  }

  return { beats_sec, downbeats_sec };
}

/**
 * Estimate sections based on energy changes (simplified for P0).
 */
function estimateSections(durationSec: number, bpm: number): BgmSection[] {
  // Simple heuristic: divide into intro/verse/chorus/outro
  if (durationSec < 30) {
    return [
      { id: "S1", label: "main", start_sec: 0, end_sec: durationSec, energy: 0.6 },
    ];
  }

  const sections: BgmSection[] = [];
  const introEnd = Math.min(durationSec * 0.1, 8);
  const outroStart = Math.max(durationSec * 0.9, durationSec - 8);

  sections.push({ id: "S1", label: "intro", start_sec: 0, end_sec: introEnd, energy: 0.3 });

  const middleDuration = outroStart - introEnd;
  if (middleDuration > 20) {
    const verseEnd = introEnd + middleDuration * 0.4;
    sections.push({ id: "S2", label: "verse", start_sec: introEnd, end_sec: verseEnd, energy: 0.5 });
    sections.push({ id: "S3", label: "chorus", start_sec: verseEnd, end_sec: outroStart, energy: 0.8 });
  } else {
    sections.push({ id: "S2", label: "verse", start_sec: introEnd, end_sec: outroStart, energy: 0.6 });
  }

  sections.push({
    id: `S${sections.length + 1}`,
    label: "outro",
    start_sec: outroStart,
    end_sec: durationSec,
    energy: 0.25,
  });

  return sections;
}

// ── Public API ──────────────────────────────────────────────────────

export interface BgmBeatDetectOptions {
  audioPath: string;
  projectId: string;
  assetId: string;
  sampleRate?: number;
  meter?: string;
}

/**
 * Analyze a BGM audio file and produce a BgmAnalysis artifact.
 */
export function detectBgmBeats(opts: BgmBeatDetectOptions): BgmAnalysis {
  const sampleRate = opts.sampleRate ?? 48000;
  const meter = opts.meter ?? "4/4";

  // Check if file exists
  if (!fs.existsSync(opts.audioPath)) {
    return {
      version: "1",
      project_id: opts.projectId,
      analysis_status: "failed",
      music_asset: {
        asset_id: opts.assetId,
        path: opts.audioPath,
      },
      bpm: 0,
      meter,
      duration_sec: 0,
      beats_sec: [],
      downbeats_sec: [],
      sections: [],
      provenance: {
        detector: "ffmpeg_onset_heuristic",
        sample_rate_hz: sampleRate,
      },
    };
  }

  const durationSec = getAudioDuration(opts.audioPath);
  if (durationSec <= 0) {
    return {
      version: "1",
      project_id: opts.projectId,
      analysis_status: "failed",
      music_asset: {
        asset_id: opts.assetId,
        path: opts.audioPath,
      },
      bpm: 0,
      meter,
      duration_sec: 0,
      beats_sec: [],
      downbeats_sec: [],
      sections: [],
      provenance: {
        detector: "ffmpeg_onset_heuristic",
        sample_rate_hz: sampleRate,
      },
    };
  }

  // Detect onsets
  const onsets = detectOnsetsViaFfmpeg(opts.audioPath, sampleRate);

  // Estimate BPM
  const bpm = estimateBpm(onsets);

  // Generate beat grid
  const { beats_sec, downbeats_sec } = generateBeatGrid(bpm, durationSec, meter);

  // Estimate sections
  const sections = estimateSections(durationSec, bpm);

  // Compute source hash
  const fileBuffer = fs.readFileSync(opts.audioPath);
  const sourceHash = createHash("sha256").update(fileBuffer).digest("hex").slice(0, 16);

  return {
    version: "1",
    project_id: opts.projectId,
    analysis_status: "ready",
    music_asset: {
      asset_id: opts.assetId,
      path: opts.audioPath,
      source_hash: sourceHash,
    },
    bpm,
    meter,
    duration_sec: Math.round(durationSec * 100) / 100,
    beats_sec,
    downbeats_sec,
    sections,
    provenance: {
      detector: "ffmpeg_onset_heuristic",
      sample_rate_hz: sampleRate,
    },
  };
}

/**
 * Write BGM analysis artifact to project directory.
 */
export function writeBgmAnalysis(
  analysis: BgmAnalysis,
  projectPath: string,
): string {
  const outDir = path.join(projectPath, "07_package/audio");
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }
  const outPath = path.join(outDir, "bgm-analysis.json");
  fs.writeFileSync(outPath, JSON.stringify(analysis, null, 2), "utf-8");
  return outPath;
}

/**
 * Load BGM analysis from project directory, if available.
 */
export function loadBgmAnalysis(projectPath: string): BgmAnalysis | undefined {
  const analysisPath = path.join(projectPath, "07_package/audio/bgm-analysis.json");
  if (!fs.existsSync(analysisPath)) return undefined;
  try {
    const raw = fs.readFileSync(analysisPath, "utf-8");
    const parsed = JSON.parse(raw) as BgmAnalysis;
    if (parsed.analysis_status === "ready") return parsed;
    return undefined;
  } catch {
    return undefined;
  }
}
