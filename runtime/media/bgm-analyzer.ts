// BGM Analyzer — Enhanced beat/section analysis for music-synchronized editing.
//
// Strategy:
//   1. aubiotrack (aubio tools) — preferred for beat detection with onset strength
//   2. ffmpeg ebur128 — fallback for energy-based beat/section estimation
//   3. librosa (Python) — optional high-accuracy mode for section labeling
//
// Output: 03_analysis/bgm_analysis.json
//
// This module augments the existing bgm-beat-detector.ts (which writes to 07_package/)
// by running during the analysis phase and producing richer beat data (with strength).

import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync, spawnSync, type ExecSyncOptionsWithStringEncoding } from "node:child_process";
import { createHash } from "node:crypto";
import type { BgmAnalysis, BgmSection } from "../compiler/transition-types.js";
import { sha256FileHex } from "../source-content-identity.js";
import {
  hasM2BgmProvenance,
  isBgmAnalysisAcceptedForConsumption,
} from "./bgm-analysis-contract.js";

// ── Types ───────────────────────────────────────────────────────────

export interface BeatEvent {
  time_sec: number;
  strength: number;
  evidence_classification?: "measured" | "synthetic" | "unavailable";
}

/** Backend evidence accepted by the canonical public BGM analysis route. */
export interface BgmMeasuredEvidence {
  bpm: number;
  bpmConfidence: number;
  meter?: string;
  beats: BeatEvent[];
  onsets: BeatEvent[];
  downbeats?: Array<{ time_sec: number; strength?: number; evidence_classification?: string }>;
  sections: BgmSection[];
}

/** Deterministic backend seam for tests and local measurement providers. */
export interface BgmMeasuredBackend {
  name: string;
  version: string;
  sampleRateHz: number;
  /** Input rate observed by the backend; required for a truthful ready record. */
  inputSampleRateHz?: number;
  /** Processing rate actually used by the backend; required for a truthful ready record. */
  processingSampleRateHz?: number;
  hopLengthSamples: number;
  windowLengthSamples: number;
  analyze: (audioPath: string) => BgmMeasuredEvidence | null;
}

export interface BgmAnalyzerOptions {
  audioPath: string;
  projectDir: string;
  projectId: string;
  assetId: string;
  sampleRate?: number;
  meter?: string;
  /** Force a specific detector backend ("aubiotrack" | "ffmpeg" | "librosa"). */
  forceBackend?: "aubiotrack" | "ffmpeg" | "librosa";
  /** Optional deterministic measured backend; null records provider unavailability. */
  measuredBackend?: BgmMeasuredBackend | null;
}

export interface BgmAnalysisResult extends BgmAnalysis {
  /** Beats with per-event onset strength (0–1). */
  beats: BeatEvent[];
}

export const BGM_ANALYSIS_RELATIVE_PATH = "03_analysis/bgm_analysis.json";

// ── Tool availability checks ────────────────────────────────────────

const EXEC_OPTS: ExecSyncOptionsWithStringEncoding = {
  encoding: "utf-8",
  timeout: 10_000,
  stdio: ["pipe", "pipe", "pipe"],
};

export function isAubioAvailable(): boolean {
  try {
    execFileSync("aubiotrack", ["--help"], { ...EXEC_OPTS, stdio: ["pipe", "pipe", "pipe"] });
    return true;
  } catch {
    return false;
  }
}

export function isLibrosaAvailable(): boolean {
  try {
    execFileSync("python3", ["-c", "import librosa"], { ...EXEC_OPTS, stdio: ["pipe", "pipe", "pipe"] });
    return true;
  } catch {
    return false;
  }
}

// ── Backend: aubiotrack ─────────────────────────────────────────────

/**
 * Run aubiotrack to detect beat positions.
 * Returns beat timestamps with uniform strength (aubiotrack does not output onset strength).
 */
export function detectBeatsViaAubio(audioPath: string): BeatEvent[] {
  try {
    const raw = execFileSync(
      "aubiotrack",
      ["-i", audioPath, "-B", "1024", "-H", "512"],
      { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024, timeout: 120_000 },
    );
    const beats: BeatEvent[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const t = parseFloat(trimmed);
      if (!Number.isFinite(t) || t < 0) continue;
      beats.push({ time_sec: Math.round(t * 1000) / 1000, strength: 1.0 });
    }
    return beats;
  } catch {
    return [];
  }
}

// ── Backend: ffmpeg ebur128 energy analysis ─────────────────────────

/**
 * Extract momentary loudness profile via ffmpeg ebur128 filter.
 * Returns an array of {time_sec, lufs} entries at ~100ms resolution.
 */
export function parseEbur128Profile(
  raw: string,
): Array<{ time_sec: number; lufs: number }> {
  const profile: Array<{ time_sec: number; lufs: number }> = [];
  const framePattern =
    /\bt:\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s+.*?\bM:\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+))(?:\s|$)/;
  for (const line of raw.split(/\r\n?|\n/)) {
    const match = framePattern.exec(line);
    if (!match) continue;
    const time_sec = Number(match[1]);
    const lufs = Number(match[2]);
    if (Number.isFinite(time_sec) && Number.isFinite(lufs)) {
      profile.push({ time_sec, lufs });
    }
  }
  return profile;
}

export function extractEbur128Profile(
  audioPath: string,
): Array<{ time_sec: number; lufs: number }> {
  try {
    // ebur128's verbose frame log is emitted on stderr even when ffmpeg exits
    // successfully. spawnSync retains both streams; execFileSync would only
    // return stdout on the normal path and silently erase the measurement.
    const result = spawnSync(
      "ffmpeg",
      [
        "-hide_banner",
        "-nostdin",
        "-loglevel", "verbose",
        "-i", audioPath,
        "-map", "0:a:0",
        "-af", "ebur128=peak=true:framelog=verbose",
        "-f", "null",
        "-",
      ],
      { encoding: "utf-8", maxBuffer: 50 * 1024 * 1024, timeout: 120_000, stdio: ["pipe", "pipe", "pipe"] },
    );
    if (result.error || result.status !== 0) return [];
    const raw = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    return parseEbur128Profile(raw);
  } catch {
    return [];
  }
}

/**
 * Detect beats from energy profile using onset detection heuristic.
 * Finds local peaks in the LUFS curve above a threshold.
 */
export function detectBeatsFromEnergy(
  profile: Array<{ time_sec: number; lufs: number }>,
): BeatEvent[] {
  if (profile.length < 3) return [];

  // Compute adaptive threshold: median LUFS + 3dB
  const sorted = profile.map((p) => p.lufs).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const threshold = median + 3;

  // Find peaks: points higher than both neighbors
  const beats: BeatEvent[] = [];
  const minInterval = 0.15; // minimum 150ms between beats
  let lastBeatTime = -1;

  for (let i = 1; i < profile.length - 1; i++) {
    const cur = profile[i];
    if (
      cur.lufs > threshold &&
      cur.lufs >= profile[i - 1].lufs &&
      cur.lufs >= profile[i + 1].lufs &&
      cur.time_sec - lastBeatTime >= minInterval
    ) {
      // Normalize strength: map LUFS to 0–1 range
      const maxLufs = sorted[sorted.length - 1];
      const minLufs = sorted[0];
      const range = maxLufs - minLufs;
      const strength = range > 0 ? Math.max(0, Math.min(1, (cur.lufs - minLufs) / range)) : 0.5;

      beats.push({
        time_sec: Math.round(cur.time_sec * 1000) / 1000,
        strength: Math.round(strength * 100) / 100,
      });
      lastBeatTime = cur.time_sec;
    }
  }

  return beats;
}

// ── Backend: librosa (Python bridge) ────────────────────────────────

interface LibrosaResult {
  bpm: number;
  beats: BeatEvent[];
  sections: Array<{ label: string; start_sec: number; end_sec: number; energy: number }>;
  downbeats: BeatEvent[];
  backend_version: string;
  processing_sample_rate_hz: number;
  hop_length_samples: number;
  window_length_samples: number;
}

/**
 * Run librosa-based analysis via a Python bridge script.
 * Produces higher-quality beat detection with onset strength and chorus detection.
 */
export function analyzeViaLibrosa(audioPath: string): LibrosaResult | null {
  const script = `
import sys, json, warnings
warnings.filterwarnings("ignore")
import librosa
import numpy as np

path = sys.argv[1]
processing_sample_rate_hz = 22050
hop_length_samples = 512
window_length_samples = 2048
y, sr = librosa.load(path, sr=processing_sample_rate_hz, mono=True)
duration = librosa.get_duration(y=y, sr=sr)

# Beat tracking
tempo, beat_frames = librosa.beat.beat_track(
    y=y, sr=sr, hop_length=hop_length_samples, units='frames'
)
beat_times = librosa.frames_to_time(beat_frames, sr=sr, hop_length=hop_length_samples)

# Onset strength for each beat
onset_env = librosa.onset.onset_strength(
    y=y, sr=sr, hop_length=hop_length_samples, n_fft=window_length_samples
)
beat_strengths = []
for bf in beat_frames:
    if bf < len(onset_env):
        beat_strengths.append(float(onset_env[bf]))
    else:
        beat_strengths.append(0.0)

# Normalize strengths to 0–1
max_s = max(beat_strengths) if beat_strengths else 1.0
beat_strengths = [s / max_s if max_s > 0 else 0.5 for s in beat_strengths]

beats = [{"time_sec": round(float(t), 3), "strength": round(s, 2)}
         for t, s in zip(beat_times, beat_strengths)]

# This path measures beat/onset timing, but it does not measure meter or
# downbeat identity. Do not infer a 4/4 bar grid or relabel onset strength as
# downbeat strength; typed downbeats remain empty until a backend measures it.
downbeats = []

# Section detection via spectral clustering (structural segmentation)
try:
    bound_frames = librosa.segment.agglomerative(
        librosa.feature.mfcc(
            y=y, sr=sr, n_mfcc=13, n_fft=window_length_samples,
            hop_length=hop_length_samples,
        ), k=min(8, max(2, int(duration / 15)))
    )
    bound_times = librosa.frames_to_time(bound_frames, sr=sr, hop_length=hop_length_samples)
    bound_times = np.concatenate([[0.0], bound_times, [duration]])
    bound_times = np.unique(np.sort(bound_times))
except Exception:
    # Fallback: simple energy-based segmentation
    bound_times = np.array([0.0, duration])

# Compute per-section energy. Librosa 0.11's default RMS frame length and hop
# are 2048/512, which are the actual values recorded above for this backend.
rms = librosa.feature.rms(y=y)[0]
rms_times = librosa.frames_to_time(
    np.arange(len(rms)), sr=sr, hop_length=hop_length_samples
)
max_rms = float(np.max(rms)) if len(rms) > 0 else 1.0

sections = []
for i in range(len(bound_times) - 1):
    start = float(bound_times[i])
    end = float(bound_times[i + 1])
    mask = (rms_times >= start) & (rms_times < end)
    energy = float(np.mean(rms[mask])) / max_rms if mask.any() and max_rms > 0 else 0.5
    sections.append({"start_sec": round(start, 2), "end_sec": round(end, 2), "energy": round(energy, 2)})

# Label sections heuristically by energy
if len(sections) > 0:
    energies = [s["energy"] for s in sections]
    max_e = max(energies)
    for idx, sec in enumerate(sections):
        ratio = sec["energy"] / max_e if max_e > 0 else 0.5
        if idx == 0 and ratio < 0.6:
            sec["label"] = "intro"
        elif idx == len(sections) - 1 and ratio < 0.6:
            sec["label"] = "outro"
        elif ratio >= 0.75:
            sec["label"] = "chorus"
        elif ratio >= 0.5:
            sec["label"] = "verse"
        else:
            sec["label"] = "bridge"

result = {
    "bpm": round(bpm_val, 1),
    "beats": beats,
    "sections": sections,
    "downbeats": downbeats,
    "backend_version": str(librosa.__version__),
    "processing_sample_rate_hz": int(sr),
    "hop_length_samples": hop_length_samples,
    "window_length_samples": window_length_samples,
}
print(json.dumps(result))
`.trim();

  try {
    const raw = execFileSync(
      "python3",
      ["-c", script, audioPath],
      { encoding: "utf-8", maxBuffer: 50 * 1024 * 1024, timeout: 300_000 },
    );
    const parsed = JSON.parse(raw.trim()) as LibrosaResult;
    return parsed;
  } catch {
    return null;
  }
}

// ── BPM estimation ──────────────────────────────────────────────────

/**
 * Estimate BPM from beat intervals.
 * Uses median-of-intervals with octave correction.
 */
export function estimateBpm(beats: BeatEvent[]): number {
  if (beats.length < 4) return 120;

  const intervals: number[] = [];
  for (let i = 1; i < beats.length; i++) {
    const interval = beats[i].time_sec - beats[i - 1].time_sec;
    if (interval > 0.1 && interval < 2.0) {
      intervals.push(interval);
    }
  }
  if (intervals.length === 0) return 120;

  intervals.sort((a, b) => a - b);
  const median = intervals[Math.floor(intervals.length / 2)];
  let bpm = 60 / median;

  // Octave correction: clamp to 60–200 range
  while (bpm > 200) bpm /= 2;
  while (bpm < 60) bpm *= 2;

  return Math.round(bpm * 10) / 10;
}

// ── Section estimation (heuristic, no librosa) ──────────────────────

/**
 * Estimate sections from energy profile using change-point detection.
 * Segments the loudness curve into regions of similar energy and labels them.
 */
export function estimateSectionsFromEnergy(
  profile: Array<{ time_sec: number; lufs: number }>,
  durationSec: number,
): BgmSection[] {
  if (durationSec < 10 || profile.length < 10) {
    return [{ id: "S1", label: "main", start_sec: 0, end_sec: durationSec, energy: 0.6 }];
  }

  // Downsample to ~1 second resolution
  const windowSec = 1.0;
  const windows: Array<{ start: number; end: number; avgLufs: number }> = [];
  let winStart = 0;
  while (winStart < durationSec) {
    const winEnd = Math.min(winStart + windowSec, durationSec);
    const entries = profile.filter((p) => p.time_sec >= winStart && p.time_sec < winEnd);
    const avgLufs = entries.length > 0
      ? entries.reduce((sum, e) => sum + e.lufs, 0) / entries.length
      : -70;
    windows.push({ start: winStart, end: winEnd, avgLufs });
    winStart = winEnd;
  }

  if (windows.length === 0) {
    return [{ id: "S1", label: "main", start_sec: 0, end_sec: durationSec, energy: 0.6 }];
  }

  // Normalize LUFS to 0–1 energy
  const lufsValues = windows.map((w) => w.avgLufs);
  const minLufs = Math.min(...lufsValues);
  const maxLufs = Math.max(...lufsValues);
  const lufsRange = maxLufs - minLufs;

  const normalized = windows.map((w) => ({
    ...w,
    energy: lufsRange > 0 ? (w.avgLufs - minLufs) / lufsRange : 0.5,
  }));

  // Change-point detection: find boundaries where energy changes significantly
  const boundaries: number[] = [0];
  const changeThreshold = 0.2;
  const minSectionDuration = 4.0; // minimum 4 seconds per section
  let prevEnergy = normalized[0].energy;
  let runStart = 0;

  for (let i = 1; i < normalized.length; i++) {
    const diff = Math.abs(normalized[i].energy - prevEnergy);
    const elapsed = normalized[i].start - normalized[runStart].start;

    if (diff > changeThreshold && elapsed >= minSectionDuration) {
      boundaries.push(normalized[i].start);
      runStart = i;
      prevEnergy = normalized[i].energy;
    } else {
      // Exponential moving average
      prevEnergy = prevEnergy * 0.8 + normalized[i].energy * 0.2;
    }
  }
  boundaries.push(durationSec);

  // Build sections with average energy
  const sections: BgmSection[] = [];
  for (let i = 0; i < boundaries.length - 1; i++) {
    const start = boundaries[i];
    const end = boundaries[i + 1];
    const sectionWindows = normalized.filter((w) => w.start >= start && w.start < end);
    const avgEnergy = sectionWindows.length > 0
      ? sectionWindows.reduce((sum, w) => sum + w.energy, 0) / sectionWindows.length
      : 0.5;

    sections.push({
      id: `S${i + 1}`,
      label: "unlabeled",
      start_sec: Math.round(start * 100) / 100,
      end_sec: Math.round(end * 100) / 100,
      energy: Math.round(avgEnergy * 100) / 100,
    });
  }

  // Label sections by energy and position
  labelSections(sections);

  return sections;
}

/**
 * Heuristic labeling: intro/outro by position + low energy, chorus by peak energy.
 */
export function labelSections(sections: BgmSection[]): void {
  if (sections.length === 0) return;

  const maxEnergy = Math.max(...sections.map((s) => s.energy));

  for (let i = 0; i < sections.length; i++) {
    const s = sections[i];
    const ratio = maxEnergy > 0 ? s.energy / maxEnergy : 0.5;
    const isFirst = i === 0;
    const isLast = i === sections.length - 1;

    if (isFirst && ratio < 0.6) {
      s.label = "intro";
    } else if (isLast && ratio < 0.6) {
      s.label = "outro";
    } else if (ratio >= 0.75) {
      s.label = "chorus";
    } else if (ratio >= 0.45) {
      s.label = "verse";
    } else {
      s.label = "bridge";
    }
  }
}

// ── Beat grid generation ────────────────────────────────────────────

/**
 * Generate a quantized beat grid from BPM and duration.
 * Also identifies downbeats (first beat of each bar).
 */
export function generateBeatGrid(
  bpm: number,
  durationSec: number,
  meter: string = "4/4",
): { beats: BeatEvent[]; downbeats: BeatEvent[] } {
  const beatInterval = 60 / bpm;
  const [beatsPerBar] = meter.split("/").map(Number);
  const barBeats = beatsPerBar || 4;

  const beats: BeatEvent[] = [];
  const downbeats: BeatEvent[] = [];

  for (let i = 0; i * beatInterval < durationSec; i++) {
    const t = Math.round(i * beatInterval * 1000) / 1000;
    const isDownbeat = i % barBeats === 0;
    beats.push({ time_sec: t, strength: isDownbeat ? 1.0 : 0.6 });
    if (isDownbeat) downbeats.push({ time_sec: t, strength: 1.0 });
  }

  return { beats, downbeats };
}

// ── Audio duration ──────────────────────────────────────────────────

export function getAudioDuration(audioPath: string): number {
  try {
    const raw = execFileSync(
      "ffprobe",
      ["-v", "quiet", "-show_entries", "format=duration", "-of", "csv=p=0", audioPath],
      { encoding: "utf-8", timeout: 30_000 },
    );
    return parseFloat(raw.trim()) || 0;
  } catch {
    return 0;
  }
}

/** Read the source audio stream rate without inventing a processing rate. */
function readAudioSampleRate(audioPath: string): number | undefined {
  try {
    const raw = execFileSync(
      "ffprobe",
      [
        "-v", "error",
        "-select_streams", "a:0",
        "-show_entries", "stream=sample_rate",
        "-of", "default=noprint_wrappers=1:nokey=1",
        audioPath,
      ],
      { ...EXEC_OPTS, timeout: 30_000 },
    );
    const rate = Number.parseInt(raw.trim().split(/\s+/)[0] ?? "", 10);
    return Number.isInteger(rate) && rate > 0 ? rate : undefined;
  } catch {
    return undefined;
  }
}

/** Read a provider-reported version; unavailable providers yield no version. */
function readCommandVersion(command: string, args: string[] = ["-version"]): string | undefined {
  const result = spawnSync(command, args, {
    encoding: "utf-8",
    maxBuffer: 2 * 1024 * 1024,
    timeout: 30_000,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const raw = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const match = raw.match(/\bversion\s+([^\s,]+)/i);
  return match?.[1] && match[1] !== "unknown" ? match[1] : undefined;
}

function ffmpegEbur128Metadata(audioPath: string): MeasuredBackendMetadata {
  const inputSampleRateHz = readAudioSampleRate(audioPath);
  // FFmpeg's ebur128 filter consumes the input stream without a resampling
  // filter. Its momentary loudness frame log is emitted every 100 ms and uses
  // the standard 400 ms momentary window.
  return measuredBackendMetadata({
    name: "ffmpeg_ebur128",
    version: readCommandVersion("ffmpeg"),
    inputSampleRateHz,
    processingSampleRateHz: inputSampleRateHz,
    sampleRateHz: inputSampleRateHz,
    hopLengthSamples: inputSampleRateHz ? Math.round(inputSampleRateHz * 0.1) : undefined,
    windowLengthSamples: inputSampleRateHz ? Math.round(inputSampleRateHz * 0.4) : undefined,
  }, "ffmpeg_ebur128");
}

function aubiotrackMetadata(audioPath: string): MeasuredBackendMetadata {
  const inputSampleRateHz = readAudioSampleRate(audioPath);
  return measuredBackendMetadata({
    name: "aubiotrack+ebur128",
    version: readCommandVersion("aubiotrack", ["--version"])
      ?? readCommandVersion("aubiotrack", ["--help"]),
    inputSampleRateHz,
    processingSampleRateHz: inputSampleRateHz,
    sampleRateHz: inputSampleRateHz,
    hopLengthSamples: 512,
    windowLengthSamples: 1024,
  }, "aubiotrack+ebur128");
}

// ── Source hash ──────────────────────────────────────────────────────

/**
 * Analyzer source-identity hash: sha256 over the first 16MB of the media
 * file, truncated to 16 hex chars. Exported so downstream consumers (e.g.
 * rhythm sync evidence binding) can verify a recorded music_asset.source_hash
 * against the media on disk with the exact same scheme.
 */
export function computeMediaHeadSourceHash(audioPath: string): string {
  return computeSourceHash(audioPath);
}

/** Full-file SHA-256 used by canonical BGM role binding and analysis provenance. */
export function computeMediaSourceHash(audioPath: string): string {
  return sha256FileHex(audioPath);
}

function computeSourceHash(audioPath: string): string {
  const fd = fs.openSync(audioPath, "r");
  try {
    const chunkSize = 16 * 1024 * 1024; // first 16MB
    const buf = Buffer.alloc(Math.min(chunkSize, fs.fstatSync(fd).size));
    fs.readSync(fd, buf, 0, buf.length, 0);
    return createHash("sha256").update(buf).digest("hex").slice(0, 16);
  } finally {
    fs.closeSync(fd);
  }
}

// ── Public API ──────────────────────────────────────────────────────

const MEASURED_CONFIDENCE_THRESHOLD = 0.6;

interface MeasuredBackendMetadata {
  name: string;
  version?: string;
  /** Compatibility alias retained for injected backends; complete M2 records use both explicit rates below. */
  sampleRateHz?: number;
  inputSampleRateHz?: number;
  processingSampleRateHz?: number;
  hopLengthSamples?: number;
  windowLengthSamples?: number;
}

interface NormalizedMeasuredEvidence {
  bpm: number;
  bpmConfidence: number;
  meter: string;
  beats: BeatEvent[];
  onsets: BeatEvent[];
  downbeats: BeatEvent[];
  sections: BgmSection[];
  hadSyntheticEvidence: boolean;
}

/**
 * The public BGM route only promotes complete measured evidence. The older
 * heuristic helpers below remain available to legacy callers, but this
 * normalizer deliberately drops synthetic/unavailable cues from canonical
 * output instead of allowing them to masquerade as measurements.
 */
function normalizeMeasuredEvidence(
  evidence: BgmMeasuredEvidence | null | undefined,
  durationSec: number,
): NormalizedMeasuredEvidence {
  if (!evidence || typeof evidence !== "object") {
    return {
      bpm: 0,
      bpmConfidence: 0,
      meter: "unknown",
      beats: [],
      onsets: [],
      downbeats: [],
      sections: [],
      hadSyntheticEvidence: false,
    };
  }

  let hadSyntheticEvidence = false;
  const normalizeEvents = (value: unknown): BeatEvent[] => {
    if (!Array.isArray(value)) return [];
    const events: BeatEvent[] = [];
    for (const item of value) {
      if (!item || typeof item !== "object") continue;
      const event = item as Record<string, unknown>;
      const classification = event.evidence_classification;
      if (classification === "synthetic" || classification === "unavailable") {
        hadSyntheticEvidence = true;
        continue;
      }
      const timeSec = typeof event.time_sec === "number" ? event.time_sec : Number(event.time_sec);
      const strength = typeof event.strength === "number" ? event.strength : Number(event.strength);
      if (!Number.isFinite(timeSec) || timeSec < 0 || timeSec > durationSec) continue;
      if (!Number.isFinite(strength) || strength < 0 || strength > 1) continue;
      events.push({
        time_sec: Math.round(timeSec * 1000) / 1000,
        strength: Math.round(strength * 100) / 100,
        evidence_classification: "measured",
      });
    }
    return events;
  };

  const normalizeSections = (value: unknown): BgmSection[] => {
    if (!Array.isArray(value)) return [];
    const sections: BgmSection[] = [];
    for (const item of value) {
      if (!item || typeof item !== "object") continue;
      const section = item as Record<string, unknown>;
      const classification = section.evidence_classification;
      if (classification === "synthetic" || classification === "unavailable") {
        hadSyntheticEvidence = true;
        continue;
      }
      const startSec = typeof section.start_sec === "number" ? section.start_sec : Number(section.start_sec);
      const endSec = typeof section.end_sec === "number" ? section.end_sec : Number(section.end_sec);
      const energy = typeof section.energy === "number" ? section.energy : Number(section.energy);
      if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || !Number.isFinite(energy)) continue;
      const start = Math.max(0, startSec);
      const end = Math.min(durationSec, endSec);
      if (end <= start || energy < 0 || energy > 1) continue;
      sections.push({
        id: typeof section.id === "string" && section.id.length > 0 ? section.id : `S${sections.length + 1}`,
        label: typeof section.label === "string" && section.label.length > 0 ? section.label : "unlabeled",
        start_sec: Math.round(start * 100) / 100,
        end_sec: Math.round(end * 100) / 100,
        energy: Math.round(energy * 100) / 100,
        evidence_classification: "measured",
      });
    }
    return sections;
  };

  const downbeats: BeatEvent[] = [];
  if (Array.isArray(evidence.downbeats)) {
    for (const item of evidence.downbeats) {
      if (!item || typeof item !== "object") continue;
      const downbeat = item as Record<string, unknown>;
      const classification = downbeat.evidence_classification;
      if (classification === "synthetic" || classification === "unavailable") {
        hadSyntheticEvidence = true;
        continue;
      }
      const timeSec = typeof downbeat.time_sec === "number" ? downbeat.time_sec : Number(downbeat.time_sec);
      const strength = typeof downbeat.strength === "number" ? downbeat.strength : Number(downbeat.strength);
      // A downbeat without its measured strength is not an admitted sync
      // cue. Keep it out of both the typed field and the legacy projection;
      // otherwise a low-confidence/unknown meter downbeat could be revived
      // later from downbeats_sec.
      if (
        Number.isFinite(timeSec) && timeSec >= 0 && timeSec <= durationSec &&
        Number.isFinite(strength) && strength >= 0 && strength <= 1
      ) {
        downbeats.push({
          time_sec: Math.round(timeSec * 1000) / 1000,
          strength: Math.round(strength * 100) / 100,
          evidence_classification: "measured",
        });
      }
    }
  }

  const bpm = typeof evidence.bpm === "number" ? evidence.bpm : Number(evidence.bpm);
  const bpmConfidence = typeof evidence.bpmConfidence === "number"
    ? evidence.bpmConfidence
    : Number(evidence.bpmConfidence);
  return {
    bpm: Number.isFinite(bpm) ? bpm : 0,
    bpmConfidence: Number.isFinite(bpmConfidence) ? Math.max(0, Math.min(1, bpmConfidence)) : 0,
    meter: typeof evidence.meter === "string" && evidence.meter.length > 0 ? evidence.meter : "unknown",
    beats: normalizeEvents(evidence.beats),
    onsets: normalizeEvents(evidence.onsets),
    downbeats,
    sections: normalizeSections(evidence.sections),
    hadSyntheticEvidence,
  };
}

function measuredBackendMetadata(
  metadata: Partial<MeasuredBackendMetadata> | undefined,
  fallbackName: string,
): MeasuredBackendMetadata {
  const positiveInteger = (value: unknown): number | undefined =>
    Number.isInteger(value) && (value as number) > 0 ? value as number : undefined;
  const version = typeof metadata?.version === "string" && metadata.version.trim().length > 0 && metadata.version !== "unknown"
    ? metadata.version.trim()
    : undefined;
  const name = typeof metadata?.name === "string" && metadata.name.trim().length > 0
    ? metadata.name.trim()
    : fallbackName;
  return {
    name,
    ...(version ? { version } : {}),
    ...(positiveInteger(metadata?.sampleRateHz) ? { sampleRateHz: positiveInteger(metadata?.sampleRateHz) } : {}),
    ...(positiveInteger(metadata?.inputSampleRateHz) ? { inputSampleRateHz: positiveInteger(metadata?.inputSampleRateHz) } : {}),
    ...(positiveInteger(metadata?.processingSampleRateHz) ? { processingSampleRateHz: positiveInteger(metadata?.processingSampleRateHz) } : {}),
    ...(positiveInteger(metadata?.hopLengthSamples) ? { hopLengthSamples: positiveInteger(metadata?.hopLengthSamples) } : {}),
    ...(positiveInteger(metadata?.windowLengthSamples) ? { windowLengthSamples: positiveInteger(metadata?.windowLengthSamples) } : {}),
  };
}

function measuredBeatConfidence(beats: BeatEvent[]): number {
  if (beats.length < 4) return 0;
  const intervals = beats.slice(1)
    .map((beat, index) => beat.time_sec - beats[index].time_sec)
    .filter((interval) => interval > 0.1 && interval < 2);
  if (intervals.length < 3) return 0;
  const sorted = [...intervals].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  if (!Number.isFinite(median) || median <= 0) return 0;
  const deviation = intervals.reduce((sum, interval) => sum + Math.abs(interval - median), 0) / intervals.length;
  const regularity = Math.max(0, 1 - (deviation / median) * 2);
  const countFactor = Math.min(1, beats.length / 8);
  return Math.round(Math.max(0, Math.min(1, 0.5 + 0.5 * regularity * countFactor)) * 1000) / 1000;
}

function measuredSectionsFromEnergy(
  profile: Array<{ time_sec: number; lufs: number }>,
  durationSec: number,
): BgmSection[] {
  if (profile.length < 10 || durationSec < 10) return [];
  return estimateSectionsFromEnergy(profile, durationSec).map((section) => ({
    ...section,
    label: "unlabeled",
    evidence_classification: "measured",
  }));
}

function buildMeasuredResult(
  opts: BgmAnalyzerOptions,
  durationSec: number,
  sourceHash: string,
  metadata: MeasuredBackendMetadata,
  evidence?: BgmMeasuredEvidence | null,
): BgmAnalysisResult {
  const normalized = normalizeMeasuredEvidence(evidence, durationSec);
  const metadataComplete = typeof metadata.version === "string"
    && Number.isInteger(metadata.inputSampleRateHz) && (metadata.inputSampleRateHz ?? 0) > 0
    && Number.isInteger(metadata.processingSampleRateHz) && (metadata.processingSampleRateHz ?? 0) > 0
    && Number.isInteger(metadata.hopLengthSamples) && (metadata.hopLengthSamples ?? 0) > 0
    && Number.isInteger(metadata.windowLengthSamples) && (metadata.windowLengthSamples ?? 0) > 0;
  const complete = Boolean(evidence)
    && metadataComplete
    && !normalized.hadSyntheticEvidence
    && normalized.bpm > 0
    && normalized.bpmConfidence >= MEASURED_CONFIDENCE_THRESHOLD
    && normalized.beats.length >= 4
    && normalized.onsets.length > 0
    && normalized.sections.length > 0;
  const measuredStatus = complete ? "complete" : evidence ? "partial" : "unavailable";
  const evidenceClassification = evidence && !normalized.hadSyntheticEvidence ? "measured" : "unavailable";

  return {
    version: "1",
    project_id: opts.projectId,
    analysis_status: complete ? "ready" : "partial",
    music_asset: {
      asset_id: opts.assetId,
      path: opts.audioPath,
      source_hash: sourceHash,
      source_content_sha256: sourceHash,
    },
    bpm: complete ? Math.round(normalized.bpm * 10) / 10 : 0,
    meter: complete ? normalized.meter : "unknown",
    duration_sec: Math.round(durationSec * 100) / 100,
    beats_sec: normalized.beats.map((beat) => beat.time_sec),
    downbeats_sec: complete ? normalized.downbeats.map((beat) => beat.time_sec) : [],
    sections: normalized.sections,
    beats: normalized.beats,
    onsets: normalized.onsets,
    ...(normalized.downbeats.length > 0 ? { downbeats: normalized.downbeats } : {}),
    provenance: {
      detector: evidence ? metadata.name : "measured_analysis_unavailable",
      source_content_sha256: sourceHash,
      backend_name: metadata.name,
      ...(metadata.version ? { backend_version: metadata.version } : {}),
      ...(evidence && metadata.inputSampleRateHz ? { input_sample_rate_hz: metadata.inputSampleRateHz } : {}),
      ...(evidence && metadata.processingSampleRateHz ? {
        processing_sample_rate_hz: metadata.processingSampleRateHz,
        sample_rate_hz: metadata.processingSampleRateHz,
      } : {}),
      ...(evidence && metadata.hopLengthSamples ? { hop_length_samples: metadata.hopLengthSamples } : {}),
      ...(evidence && metadata.windowLengthSamples ? { window_length_samples: metadata.windowLengthSamples } : {}),
      time_unit: "seconds",
      evidence_classification: evidenceClassification,
      measurement_status: measuredStatus,
      tempo_confidence: normalized.bpmConfidence,
      fallback_used: false,
    },
  };
}

function evidenceFromLibrosa(result: LibrosaResult): BgmMeasuredEvidence {
  const beats = result.beats.map((beat) => ({ ...beat, evidence_classification: "measured" as const }));
  return {
    bpm: result.bpm,
    bpmConfidence: measuredBeatConfidence(beats),
    meter: "unknown",
    beats,
    // The bridge reports beat/onset-strength samples, so keep them in a
    // separate onset collection without manufacturing a bar meter.
    onsets: beats.map((beat) => ({ ...beat })),
    // Librosa's bridge does not measure meter/downbeat identity. Its beat
    // strengths are already represented in `beats`/`onsets` only.
    downbeats: [],
    sections: result.sections.map((section, index) => ({
      id: `S${index + 1}`,
      label: "unlabeled",
      start_sec: section.start_sec,
      end_sec: section.end_sec,
      energy: section.energy,
      evidence_classification: "measured",
    })),
  };
}

function evidenceFromDetectedBeats(
  beats: BeatEvent[],
  sections: BgmSection[],
): BgmMeasuredEvidence {
  const measuredBeats = beats.map((beat) => ({ ...beat, evidence_classification: "measured" as const }));
  return {
    bpm: measuredBeats.length >= 4 ? estimateBpm(measuredBeats) : 0,
    bpmConfidence: measuredBeatConfidence(measuredBeats),
    meter: "unknown",
    beats: measuredBeats,
    onsets: measuredBeats.map((beat) => ({ ...beat })),
    downbeats: [],
    sections,
  };
}

function sourceHashOrEmpty(audioPath: string): string | undefined {
  try {
    if (!fs.statSync(audioPath).isFile()) return undefined;
    return computeMediaSourceHash(audioPath);
  } catch {
    return undefined;
  }
}

/**
 * Analyze a BGM audio file and produce a BgmAnalysisResult artifact.
 *
 * Detection priority for the canonical route:
 *   1. an injected measured backend (when supplied)
 *   2. librosa (if available and not forced to another backend)
 *   3. aubiotrack (if available)
 *   4. ffmpeg ebur128 energy analysis
 *
 * A backend that cannot produce complete measured evidence yields partial
 * output. This route never publishes a synthetic beat grid or ratio-labelled
 * sections as ready analysis.
 */
export function analyzeBgm(opts: BgmAnalyzerOptions): BgmAnalysisResult {
  // Validate input
  if (!fs.existsSync(opts.audioPath)) {
    return makeFailed(opts, "file_not_found");
  }

  const durationSec = getAudioDuration(opts.audioPath);
  if (durationSec <= 0) {
    return makeFailed(opts, "zero_duration");
  }

  const sourceHash = computeMediaSourceHash(opts.audioPath);
  let degraded: BgmAnalysisResult | undefined;
  const consider = (candidate: BgmAnalysisResult): BgmAnalysisResult | undefined => {
    if (candidate.analysis_status === "ready") return candidate;
    degraded ??= candidate;
    return undefined;
  };

  if (opts.measuredBackend !== undefined) {
    const backend = opts.measuredBackend;
    const metadata = measuredBackendMetadata(backend ? {
      name: backend.name,
      version: backend.version,
      sampleRateHz: backend.sampleRateHz,
      inputSampleRateHz: backend.inputSampleRateHz,
      processingSampleRateHz: backend.processingSampleRateHz,
      hopLengthSamples: backend.hopLengthSamples,
      windowLengthSamples: backend.windowLengthSamples,
    } : { name: "unavailable" }, backend?.name ?? "unavailable");
    if (!backend) return buildMeasuredResult(opts, durationSec, sourceHash, metadata);
    try {
      return buildMeasuredResult(opts, durationSec, sourceHash, metadata, backend.analyze(opts.audioPath));
    } catch {
      return buildMeasuredResult(opts, durationSec, sourceHash, metadata);
    }
  }

  const forceBackend = opts.forceBackend;
  if (forceBackend === "librosa" || (!forceBackend && isLibrosaAvailable())) {
    const result = analyzeViaLibrosa(opts.audioPath);
    if (result) {
      const candidate = buildMeasuredResult(
        opts,
        durationSec,
        sourceHash,
        measuredBackendMetadata({
          name: "librosa",
          version: result.backend_version,
          inputSampleRateHz: readAudioSampleRate(opts.audioPath),
          processingSampleRateHz: result.processing_sample_rate_hz,
          sampleRateHz: result.processing_sample_rate_hz,
          hopLengthSamples: result.hop_length_samples,
          windowLengthSamples: result.window_length_samples,
        }, "librosa"),
        evidenceFromLibrosa(result),
      );
      const ready = consider(candidate);
      if (ready) return ready;
    } else if (forceBackend === "librosa") {
      return buildMeasuredResult(
        opts,
        durationSec,
        sourceHash,
        measuredBackendMetadata({ name: "librosa" }, "librosa"),
      );
    }
    if (forceBackend === "librosa") return degraded!;
  }

  if (forceBackend === "aubiotrack" || (!forceBackend && isAubioAvailable())) {
    const rawBeats = detectBeatsViaAubio(opts.audioPath);
    const profile = extractEbur128Profile(opts.audioPath);
    const candidate = buildMeasuredResult(
      opts,
      durationSec,
      sourceHash,
      aubiotrackMetadata(opts.audioPath),
      evidenceFromDetectedBeats(rawBeats, measuredSectionsFromEnergy(profile, durationSec)),
    );
    const ready = consider(candidate);
    if (ready) return ready;
    if (forceBackend === "aubiotrack") return candidate;
  }

  if (forceBackend === "ffmpeg" || !forceBackend) {
    const profile = extractEbur128Profile(opts.audioPath);
    const rawBeats = detectBeatsFromEnergy(profile);
    const evidence = profile.length > 0
      ? evidenceFromDetectedBeats(rawBeats, measuredSectionsFromEnergy(profile, durationSec))
      : null;
    const candidate = buildMeasuredResult(
      opts,
      durationSec,
      sourceHash,
      ffmpegEbur128Metadata(opts.audioPath),
      evidence,
    );
    const ready = consider(candidate);
    if (ready) return ready;
  }

  return degraded ?? buildMeasuredResult(
    opts,
    durationSec,
    sourceHash,
    measuredBackendMetadata({ name: forceBackend ?? "unavailable" }, forceBackend ?? "unavailable"),
  );
}

// ── Merge detected beats with quantized grid ────────────────────────

/**
 * Merge detected (raw) beats with a quantized grid.
 * For each grid beat, find the closest detected beat within tolerance
 * and use its strength. Grid beats without a match get default strength.
 */
function mergeDetectedWithGrid(
  detected: BeatEvent[],
  grid: BeatEvent[],
  toleranceSec: number = 0.1,
): BeatEvent[] {
  return grid.map((g) => {
    let bestMatch: BeatEvent | undefined;
    let bestDist = Infinity;
    for (const d of detected) {
      const dist = Math.abs(d.time_sec - g.time_sec);
      if (dist < bestDist && dist <= toleranceSec) {
        bestDist = dist;
        bestMatch = d;
      }
    }
    return {
      time_sec: g.time_sec,
      strength: bestMatch ? bestMatch.strength : g.strength * 0.5,
    };
  });
}

// ── Fallback sections ───────────────────────────────────────────────

function fallbackSections(durationSec: number): BgmSection[] {
  if (durationSec < 30) {
    return [{ id: "S1", label: "main", start_sec: 0, end_sec: durationSec, energy: 0.6 }];
  }

  const introEnd = Math.min(durationSec * 0.1, 8);
  const outroStart = Math.max(durationSec * 0.9, durationSec - 8);
  const sections: BgmSection[] = [];

  sections.push({ id: "S1", label: "intro", start_sec: 0, end_sec: introEnd, energy: 0.3 });

  const midDuration = outroStart - introEnd;
  if (midDuration > 20) {
    const verseEnd = introEnd + midDuration * 0.4;
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

// ── Failed result factory ───────────────────────────────────────────

function makeFailed(
  opts: BgmAnalyzerOptions,
  reason: string,
): BgmAnalysisResult {
  const sourceHash = sourceHashOrEmpty(opts.audioPath);
  return {
    version: "1",
    project_id: opts.projectId,
    analysis_status: "failed",
    music_asset: {
      asset_id: opts.assetId,
      path: opts.audioPath,
      ...(sourceHash ? { source_hash: sourceHash, source_content_sha256: sourceHash } : {}),
    },
    bpm: 0,
    meter: "unknown",
    duration_sec: 0,
    beats_sec: [],
    downbeats_sec: [],
    sections: [],
    beats: [],
    onsets: [],
    provenance: {
      detector: `none:${reason}`,
      ...(sourceHash ? { source_content_sha256: sourceHash } : {}),
      backend_name: "unavailable",
      time_unit: "seconds",
      evidence_classification: "unavailable",
      measurement_status: "unavailable",
      tempo_confidence: 0,
      fallback_used: false,
    },
  };
}

// ── File I/O ────────────────────────────────────────────────────────

/** BGM audio file extensions to auto-detect. */
export const BGM_EXTENSIONS = new Set([".mp3", ".wav", ".aac", ".flac", ".ogg", ".m4a"]);

export interface ProjectBgmAnalysisOptions {
  bgmSources: Array<{ sourceFile: string; assetId: string }>;
  /** Total explicit role requests, including requests that did not resolve to a current source asset. */
  explicitRequestCount?: number;
  projectDir: string;
  projectId: string;
  /** Force one built-in detector for deterministic public-route fixtures. */
  forceBackend?: "aubiotrack" | "ffmpeg" | "librosa";
  /** Optional deterministic measured backend; null records provider unavailability. */
  measuredBackend?: BgmMeasuredBackend | null;
}

export interface ProjectBgmAnalysisResult {
  writtenPaths: string[];
  readyAssetIds: string[];
  failures: Array<{ assetId: string; reason: string }>;
}

export function resolveBgmAnalysisPath(projectPath: string): string {
  return path.join(projectPath, BGM_ANALYSIS_RELATIVE_PATH);
}

/**
 * Auto-detect BGM files in a project's source files.
 * Identifies audio-only files (no video stream) as potential BGM.
 */
export function detectBgmFiles(sourceFiles: string[]): string[] {
  return sourceFiles.filter((f) => {
    const ext = path.extname(f).toLowerCase();
    if (!BGM_EXTENSIONS.has(ext)) return false;

    // Verify it's audio-only (no video stream)
    try {
      const probe = execFileSync(
        "ffprobe",
        ["-v", "quiet", "-show_streams", "-select_streams", "v", "-of", "csv=p=0", f],
        { encoding: "utf-8", timeout: 10_000 },
      );
      // If ffprobe returns empty for video streams → audio-only
      return probe.trim().length === 0;
    } catch {
      // If ffprobe fails, still include it based on extension
      return true;
    }
  });
}

/**
 * Run project-level BGM analysis for explicitly role-tagged BGM sources.
 * Writes the canonical 03_analysis artifact before downstream stages consume it.
 */
export function runProjectBgmAnalysis(
  opts: ProjectBgmAnalysisOptions,
): ProjectBgmAnalysisResult {
  const writtenPaths: string[] = [];
  // The explicit role set is authoritative for this pipeline run. Never retain
  // a pipeline-owned BGM artifact from a prior, different source set.
  fs.rmSync(resolveBgmAnalysisPath(opts.projectDir), { force: true });
  if ((opts.explicitRequestCount ?? opts.bgmSources.length) > 1) {
    return {
      writtenPaths,
      readyAssetIds: [],
      failures: opts.bgmSources.map((source) => ({
        assetId: source.assetId,
        reason: "multiple_explicit_bgm_sources_unsupported",
      })),
    };
  }
  const readyAssetIds: string[] = [];
  const failures: ProjectBgmAnalysisResult["failures"] = [];
  for (const { sourceFile: bgmPath, assetId } of opts.bgmSources) {
    const result = analyzeBgm({
      audioPath: bgmPath,
      projectDir: opts.projectDir,
      projectId: opts.projectId,
      assetId,
      forceBackend: opts.forceBackend,
      measuredBackend: opts.measuredBackend,
    });
    writtenPaths.push(writeBgmAnalysis(result, opts.projectDir));
    if (result.analysis_status === "ready") readyAssetIds.push(assetId);
    else failures.push({ assetId, reason: `bgm_analysis_${result.analysis_status}` });
  }

  return { writtenPaths, readyAssetIds, failures };
}

/**
 * Write BGM analysis artifact to 03_analysis/ directory.
 */
export function writeBgmAnalysis(
  analysis: BgmAnalysisResult,
  projectPath: string,
): string {
  const outPath = resolveBgmAnalysisPath(projectPath);
  const outDir = path.dirname(outPath);
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }
  fs.writeFileSync(outPath, JSON.stringify(analysis, null, 2), "utf-8");
  return outPath;
}

/**
 * A BGM analysis together with the identity of the artifact file that was
 * ACTUALLY consumed, captured from a SINGLE snapshot of the bytes: the bytes
 * are read exactly once, hashed from those bytes, and parsed from those same
 * bytes — provenance can never describe different bytes than the parsed
 * analysis. The loader may fall back from the primary
 * 03_analysis/bgm_analysis.json to the legacy 07_package/audio/bgm-analysis.json;
 * consumers stamping provenance hashes must use resolved_path/origin and the
 * snapshot digest, never re-open any path.
 */
export interface LoadedBgmAnalysis {
  analysis: BgmAnalysisResult;
  /** Absolute path of the artifact file actually consumed. */
  resolvedPath: string;
  /** Which artifact was consumed. */
  origin: "primary" | "legacy_fallback";
  /** sha256 hex of the exact bytes the analysis was parsed from. */
  artifactSha256: string | undefined;
}

/** Single snapshot: read bytes once, digest + parse from those same bytes. */
function readBgmSnapshot(filePath: string): { bytes: Buffer; sha256: string } | undefined {
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(filePath);
  } catch {
    return undefined; // vanished/unreadable before snapshot: fail closed
  }
  return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
}

/**
 * Load BGM analysis from 03_analysis/ (primary) or 07_package/audio/ (fallback),
 * reporting exactly which file was consumed and the digest of the exact bytes
 * parsed (single-snapshot; the path is never re-opened).
 */
export function loadBgmAnalysisFromProjectWithSource(
  projectPath: string,
): LoadedBgmAnalysis | undefined {
  // Primary: 03_analysis/bgm_analysis.json
  const analysisPath = resolveBgmAnalysisPath(projectPath);
  const primary = readBgmSnapshot(analysisPath);
  if (primary) {
    try {
      const parsed = JSON.parse(primary.bytes.toString("utf-8")) as BgmAnalysisResult;
      if (parsed.analysis_status === "ready") {
        if (hasM2BgmProvenance(parsed) && !isBgmAnalysisAcceptedForConsumption(parsed)) return undefined;
        return {
          analysis: parsed,
          resolvedPath: analysisPath,
          origin: "primary",
          artifactSha256: primary.sha256,
        };
      }
      // A canonical measured artifact that is partial/failed is authoritative
      // for this run. Never revive a stale legacy fallback behind it.
      if (hasM2BgmProvenance(parsed)) {
        return undefined;
      }
    } catch { /* fall through */ }
  }

  // An explicit role request can fail before a primary artifact is written
  // (unmatched, multiple, or stale identity). The coverage lane is the
  // durable negative evidence that also suppresses legacy fallback.
  const coveragePath = path.join(projectPath, "03_analysis/analysis_coverage_report.json");
  try {
    const coverage = JSON.parse(fs.readFileSync(coveragePath, "utf-8")) as {
      lanes?: Array<{ lane_id?: string; required?: boolean; reason?: string | null }>;
    };
    const bgmLane = coverage.lanes?.find((lane) => lane.lane_id === "bgm_analysis");
    if (
      bgmLane?.required
      || bgmLane?.reason === "bgm analysis skipped by request"
      || bgmLane?.reason === "no_explicit_bgm_role_input"
    ) return undefined;
  } catch { /* no coverage: preserve legacy project compatibility */ }

  // Fallback: 07_package/audio/bgm-analysis.json (existing format)
  const legacyPath = path.join(projectPath, "07_package/audio/bgm-analysis.json");
  const legacy = readBgmSnapshot(legacyPath);
  if (legacy) {
    try {
      const parsed = JSON.parse(legacy.bytes.toString("utf-8")) as BgmAnalysis;
      if (parsed.analysis_status !== "ready") return undefined;
      if (hasM2BgmProvenance(parsed) && !isBgmAnalysisAcceptedForConsumption(parsed)) return undefined;
      // Upgrade legacy format: beats_sec → beats with default strength
      return {
        analysis: {
          ...parsed,
          beats: parsed.beats_sec.map((t) => ({ time_sec: t, strength: 1.0 })),
        },
        resolvedPath: legacyPath,
        origin: "legacy_fallback",
        artifactSha256: legacy.sha256,
      };
    } catch { /* fall through */ }
  }

  return undefined;
}

/**
 * Load BGM analysis from 03_analysis/ (primary) or 07_package/audio/ (fallback).
 */
export function loadBgmAnalysisFromProject(projectPath: string): BgmAnalysisResult | undefined {
  return loadBgmAnalysisFromProjectWithSource(projectPath)?.analysis;
}
