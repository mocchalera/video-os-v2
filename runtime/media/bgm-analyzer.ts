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
import { execSync, type ExecSyncOptionsWithStringEncoding } from "node:child_process";
import { createHash } from "node:crypto";
import type { BgmAnalysis, BgmSection } from "../compiler/transition-types.js";

// ── Types ───────────────────────────────────────────────────────────

export interface BeatEvent {
  time_sec: number;
  strength: number;
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
}

export interface BgmAnalysisResult extends BgmAnalysis {
  /** Beats with per-event onset strength (0–1). */
  beats: BeatEvent[];
}

// ── Tool availability checks ────────────────────────────────────────

const EXEC_OPTS: ExecSyncOptionsWithStringEncoding = {
  encoding: "utf-8",
  timeout: 10_000,
  stdio: ["pipe", "pipe", "pipe"],
};

export function isAubioAvailable(): boolean {
  try {
    execSync("aubiotrack --help 2>&1", EXEC_OPTS);
    return true;
  } catch {
    return false;
  }
}

export function isLibrosaAvailable(): boolean {
  try {
    execSync('python3 -c "import librosa" 2>&1', EXEC_OPTS);
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
    const raw = execSync(
      `aubiotrack -i "${audioPath}" -B 1024 -H 512`,
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
export function extractEbur128Profile(
  audioPath: string,
): Array<{ time_sec: number; lufs: number }> {
  try {
    const raw = execSync(
      `ffmpeg -i "${audioPath}" -af "ebur128=peak=true:framelog=verbose" -f null - 2>&1`,
      { encoding: "utf-8", maxBuffer: 50 * 1024 * 1024, timeout: 120_000 },
    );

    const profile: Array<{ time_sec: number; lufs: number }> = [];
    // Parse "t: <time>  M: <momentary_lufs>" lines
    const regex = /t:\s*([\d.]+)\s+.*?M:\s*(-?[\d.]+)/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(raw)) !== null) {
      const time_sec = parseFloat(match[1]);
      const lufs = parseFloat(match[2]);
      if (Number.isFinite(time_sec) && Number.isFinite(lufs)) {
        profile.push({ time_sec, lufs });
      }
    }
    return profile;
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
  downbeats: Array<{ time_sec: number }>;
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
y, sr = librosa.load(path, sr=22050, mono=True)
duration = librosa.get_duration(y=y, sr=sr)

# Beat tracking
tempo, beat_frames = librosa.beat.beat_track(y=y, sr=sr, units='frames')
beat_times = librosa.frames_to_time(beat_frames, sr=sr)

# Onset strength for each beat
onset_env = librosa.onset.onset_strength(y=y, sr=sr)
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

# Downbeats (first beat of each bar, assuming 4/4)
bpm_val = float(np.atleast_1d(tempo)[0])
bar_length = 4
downbeats = [{"time_sec": round(float(beat_times[i]), 3)}
             for i in range(0, len(beat_times), bar_length)]

# Section detection via spectral clustering (structural segmentation)
try:
    bound_frames = librosa.segment.agglomerative(
        librosa.feature.mfcc(y=y, sr=sr, n_mfcc=13), k=min(8, max(2, int(duration / 15)))
    )
    bound_times = librosa.frames_to_time(bound_frames, sr=sr)
    bound_times = np.concatenate([[0.0], bound_times, [duration]])
    bound_times = np.unique(np.sort(bound_times))
except Exception:
    # Fallback: simple energy-based segmentation
    bound_times = np.array([0.0, duration])

# Compute per-section energy
rms = librosa.feature.rms(y=y, sr=sr)[0]
rms_times = librosa.frames_to_time(np.arange(len(rms)), sr=sr)
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

result = {"bpm": round(bpm_val, 1), "beats": beats, "sections": sections, "downbeats": downbeats}
print(json.dumps(result))
`.trim();

  try {
    const raw = execSync(
      `python3 -c ${JSON.stringify(script)} "${audioPath}"`,
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
): { beats: BeatEvent[]; downbeats: Array<{ time_sec: number }> } {
  const beatInterval = 60 / bpm;
  const [beatsPerBar] = meter.split("/").map(Number);
  const barBeats = beatsPerBar || 4;

  const beats: BeatEvent[] = [];
  const downbeats: Array<{ time_sec: number }> = [];

  for (let i = 0; i * beatInterval < durationSec; i++) {
    const t = Math.round(i * beatInterval * 1000) / 1000;
    const isDownbeat = i % barBeats === 0;
    beats.push({ time_sec: t, strength: isDownbeat ? 1.0 : 0.6 });
    if (isDownbeat) {
      downbeats.push({ time_sec: t });
    }
  }

  return { beats, downbeats };
}

// ── Audio duration ──────────────────────────────────────────────────

export function getAudioDuration(audioPath: string): number {
  try {
    const raw = execSync(
      `ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${audioPath}"`,
      { encoding: "utf-8", timeout: 30_000 },
    );
    return parseFloat(raw.trim()) || 0;
  } catch {
    return 0;
  }
}

// ── Source hash ──────────────────────────────────────────────────────

function computeSourceHash(audioPath: string): string {
  const fd = fs.openSync(audioPath, "r");
  const chunkSize = 16 * 1024 * 1024; // first 16MB
  const buf = Buffer.alloc(Math.min(chunkSize, fs.fstatSync(fd).size));
  fs.readSync(fd, buf, 0, buf.length, 0);
  fs.closeSync(fd);
  return createHash("sha256").update(buf).digest("hex").slice(0, 16);
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Analyze a BGM audio file and produce a BgmAnalysisResult artifact.
 *
 * Detection priority:
 *   1. librosa (if available and not forced to another backend)
 *   2. aubiotrack (if available)
 *   3. ffmpeg ebur128 energy analysis (always available)
 */
export function analyzeBgm(opts: BgmAnalyzerOptions): BgmAnalysisResult {
  const sampleRate = opts.sampleRate ?? 22050;
  const meter = opts.meter ?? "4/4";

  // Validate input
  if (!fs.existsSync(opts.audioPath)) {
    return makeFailed(opts, meter, sampleRate, "file_not_found");
  }

  const durationSec = getAudioDuration(opts.audioPath);
  if (durationSec <= 0) {
    return makeFailed(opts, meter, sampleRate, "zero_duration");
  }

  const sourceHash = computeSourceHash(opts.audioPath);

  // Choose backend
  const forceBackend = opts.forceBackend;
  const useLibrosa = forceBackend === "librosa" || (!forceBackend && isLibrosaAvailable());
  const useAubio = forceBackend === "aubiotrack" || (!forceBackend && !useLibrosa && isAubioAvailable());

  // ── Librosa path (highest quality) ────────────────────────────────
  if (useLibrosa) {
    const result = analyzeViaLibrosa(opts.audioPath);
    if (result && result.beats.length > 0) {
      // Label sections if not already labeled
      const sections: BgmSection[] = result.sections.map((s, i) => ({
        id: `S${i + 1}`,
        label: s.label || "unlabeled",
        start_sec: s.start_sec,
        end_sec: s.end_sec,
        energy: s.energy,
      }));

      return {
        version: "1",
        project_id: opts.projectId,
        analysis_status: "ready",
        music_asset: { asset_id: opts.assetId, path: opts.audioPath, source_hash: sourceHash },
        bpm: result.bpm,
        meter,
        duration_sec: Math.round(durationSec * 100) / 100,
        beats_sec: result.beats.map((b) => b.time_sec),
        downbeats_sec: result.downbeats.map((d) => d.time_sec),
        sections,
        beats: result.beats,
        provenance: { detector: "librosa", sample_rate_hz: sampleRate },
      };
    }
    // Fall through to aubio/ffmpeg if librosa failed
  }

  // ── Aubiotrack path ───────────────────────────────────────────────
  if (useAubio || (!useLibrosa && isAubioAvailable())) {
    const rawBeats = detectBeatsViaAubio(opts.audioPath);
    if (rawBeats.length >= 4) {
      const bpm = estimateBpm(rawBeats);
      // Use aubio beats but generate proper grid for downstream
      const { beats: gridBeats, downbeats } = generateBeatGrid(bpm, durationSec, meter);
      // Merge aubio detected beats with grid strengths
      const beats = mergeDetectedWithGrid(rawBeats, gridBeats);

      // Section estimation via ebur128 energy
      const profile = extractEbur128Profile(opts.audioPath);
      const sections = profile.length > 0
        ? estimateSectionsFromEnergy(profile, durationSec)
        : fallbackSections(durationSec);

      return {
        version: "1",
        project_id: opts.projectId,
        analysis_status: "ready",
        music_asset: { asset_id: opts.assetId, path: opts.audioPath, source_hash: sourceHash },
        bpm,
        meter,
        duration_sec: Math.round(durationSec * 100) / 100,
        beats_sec: beats.map((b) => b.time_sec),
        downbeats_sec: downbeats.map((d) => d.time_sec),
        sections,
        beats,
        provenance: { detector: "aubiotrack+ebur128", sample_rate_hz: sampleRate },
      };
    }
  }

  // ── FFmpeg energy path (fallback) ──────────────────────────────────
  const profile = extractEbur128Profile(opts.audioPath);
  if (profile.length > 0) {
    const rawBeats = detectBeatsFromEnergy(profile);

    if (rawBeats.length >= 4) {
      const bpm = estimateBpm(rawBeats);
      const { beats: gridBeats, downbeats } = generateBeatGrid(bpm, durationSec, meter);
      const beats = mergeDetectedWithGrid(rawBeats, gridBeats);
      const sections = estimateSectionsFromEnergy(profile, durationSec);

      return {
        version: "1",
        project_id: opts.projectId,
        analysis_status: "ready",
        music_asset: { asset_id: opts.assetId, path: opts.audioPath, source_hash: sourceHash },
        bpm,
        meter,
        duration_sec: Math.round(durationSec * 100) / 100,
        beats_sec: beats.map((b) => b.time_sec),
        downbeats_sec: downbeats.map((d) => d.time_sec),
        sections,
        beats,
        provenance: { detector: "ffmpeg_ebur128", sample_rate_hz: sampleRate },
      };
    }

    // Partial result — got energy profile but not enough beats
    const sections = estimateSectionsFromEnergy(profile, durationSec);
    return {
      version: "1",
      project_id: opts.projectId,
      analysis_status: "partial",
      music_asset: { asset_id: opts.assetId, path: opts.audioPath, source_hash: sourceHash },
      bpm: 0,
      meter,
      duration_sec: Math.round(durationSec * 100) / 100,
      beats_sec: [],
      downbeats_sec: [],
      sections,
      beats: [],
      provenance: { detector: "ffmpeg_ebur128", sample_rate_hz: sampleRate },
    };
  }

  // Nothing worked — return partial with duration
  return {
    version: "1",
    project_id: opts.projectId,
    analysis_status: "partial",
    music_asset: { asset_id: opts.assetId, path: opts.audioPath, source_hash: sourceHash },
    bpm: 0,
    meter,
    duration_sec: Math.round(durationSec * 100) / 100,
    beats_sec: [],
    downbeats_sec: [],
    sections: fallbackSections(durationSec),
    beats: [],
    provenance: { detector: "ffmpeg_ebur128", sample_rate_hz: sampleRate },
  };
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
  meter: string,
  sampleRate: number,
  _reason: string,
): BgmAnalysisResult {
  return {
    version: "1",
    project_id: opts.projectId,
    analysis_status: "failed",
    music_asset: { asset_id: opts.assetId, path: opts.audioPath },
    bpm: 0,
    meter,
    duration_sec: 0,
    beats_sec: [],
    downbeats_sec: [],
    sections: [],
    beats: [],
    provenance: { detector: "none", sample_rate_hz: sampleRate },
  };
}

// ── File I/O ────────────────────────────────────────────────────────

/** BGM audio file extensions to auto-detect. */
export const BGM_EXTENSIONS = new Set([".mp3", ".wav", ".aac", ".flac", ".ogg", ".m4a"]);

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
      const probe = execSync(
        `ffprobe -v quiet -show_streams -select_streams v -of csv=p=0 "${f}"`,
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
 * Write BGM analysis artifact to 03_analysis/ directory.
 */
export function writeBgmAnalysis(
  analysis: BgmAnalysisResult,
  projectPath: string,
): string {
  const outDir = path.join(projectPath, "03_analysis");
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }
  const outPath = path.join(outDir, "bgm_analysis.json");
  fs.writeFileSync(outPath, JSON.stringify(analysis, null, 2), "utf-8");
  return outPath;
}

/**
 * Load BGM analysis from 03_analysis/ (primary) or 07_package/audio/ (fallback).
 */
export function loadBgmAnalysisFromProject(projectPath: string): BgmAnalysisResult | undefined {
  // Primary: 03_analysis/bgm_analysis.json
  const analysisPath = path.join(projectPath, "03_analysis/bgm_analysis.json");
  if (fs.existsSync(analysisPath)) {
    try {
      const raw = fs.readFileSync(analysisPath, "utf-8");
      const parsed = JSON.parse(raw) as BgmAnalysisResult;
      if (parsed.analysis_status === "ready") return parsed;
    } catch { /* fall through */ }
  }

  // Fallback: 07_package/audio/bgm-analysis.json (existing format)
  const legacyPath = path.join(projectPath, "07_package/audio/bgm-analysis.json");
  if (fs.existsSync(legacyPath)) {
    try {
      const raw = fs.readFileSync(legacyPath, "utf-8");
      const parsed = JSON.parse(raw) as BgmAnalysis;
      if (parsed.analysis_status !== "ready") return undefined;
      // Upgrade legacy format: beats_sec → beats with default strength
      return {
        ...parsed,
        beats: parsed.beats_sec.map((t) => ({ time_sec: t, strength: 1.0 })),
      };
    } catch { /* fall through */ }
  }

  return undefined;
}
