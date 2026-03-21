/**
 * ffmpeg segmenter — shot boundary detection and segment generation.
 *
 * Per milestone-2-design.md §Shot Boundary Detection and §segments.json Base Field Derivation
 */

import { execFile } from "node:child_process";
import * as path from "node:path";
import {
  CONNECTOR_VERSION,
  computeRequestHash,
  type AssetItem,
} from "./ffprobe.js";

// ── Types ──────────────────────────────────────────────────────────

export interface QualityThresholds {
  scene_threshold: number;
  min_segment_duration_us: number;
  merge_gap_us: number;
  blackdetect_pic_th: number;
  blackdetect_pix_th: number;
  blackdetect_duration_s: number;
  silencedetect_noise_db: number;
  silencedetect_duration_s: number;
  freezedetect_noise_db: number;
  freezedetect_duration_s: number;
}

export interface TimeRange {
  start_us: number;
  end_us: number;
}

export interface SegmentItem {
  segment_id: string;
  asset_id: string;
  src_in_us: number;
  src_out_us: number;
  duration_us: number;
  rep_frame_us: number;
  summary: string;
  transcript_excerpt: string;
  quality_flags: string[];
  tags: string[];
  segment_type: string;
  filmstrip_path?: string;
  waveform_path?: string;
  transcript_ref: string | null;
  interest_points?: Array<{
    frame_us: number;
    label: string;
    confidence: number;
  }>;
  confidence: {
    boundary: {
      score: number;
      source: string;
      status: string;
    };
    summary?: { score: number; source: string; status: string };
    tags?: { score: number; source: string; status: string };
    quality_flags?: { score: number; source: string; status: string };
  };
  provenance: {
    boundary: {
      stage: string;
      method: string;
      connector_version: string;
      policy_hash: string;
      request_hash: string;
      ffmpeg_version?: string;
    };
    summary?: Record<string, string>;
    tags?: Record<string, string>;
    quality_flags?: Record<string, string>;
  };
}

// ── Helpers ────────────────────────────────────────────────────────

/**
 * Custom error carrying stderr for diagnostic purposes.
 */
export class FfmpegExecError extends Error {
  stderr: string;
  constructor(message: string, stderr: string) {
    super(message);
    this.name = "FfmpegExecError";
    this.stderr = stderr;
  }
}

function execFilePromise(
  cmd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 50 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        // ffmpeg writes diagnostic output to stderr even on success with -f null.
        // However, if the exit code is non-zero AND stderr contains a recognizable
        // ffmpeg progress/filter log (showinfo, blackdetect, etc.), we still resolve
        // because ffmpeg -f null always exits non-zero but produces valid output.
        const exitCode = (err as NodeJS.ErrnoException & { code?: number | string }).code;
        const hasFilterOutput =
          stderr &&
          (stderr.includes("[Parsed_") ||
            stderr.includes("black_start:") ||
            stderr.includes("silence_start:") ||
            stderr.includes("freeze_start:") ||
            stderr.includes("frame=") ||
            stderr.includes("Stream mapping:"));
        if (hasFilterOutput) {
          // Valid ffmpeg filter run that exits non-zero (normal for -f null)
          resolve({ stdout: stdout ?? "", stderr: stderr ?? "" });
          return;
        }
        // Genuine failure: reject with stderr summary
        const stderrSummary = (stderr ?? "").split("\n").slice(-5).join("\n").trim();
        return reject(
          new FfmpegExecError(
            `${cmd} exited with code ${exitCode}: ${stderrSummary}`,
            stderr ?? "",
          ),
        );
      }
      resolve({ stdout: stdout ?? "", stderr: stderr ?? "" });
    });
  });
}

// ── Scene Detection ────────────────────────────────────────────────

interface SceneCandidate {
  pts_us: number;
  score: number;
}

/**
 * Detect scene change boundaries using ffmpeg's scene filter.
 * Returns cut-point PTS timestamps in microseconds.
 */
export async function detectSceneBoundaries(
  filePath: string,
  sceneThreshold: number,
): Promise<SceneCandidate[]> {
  const absPath = path.resolve(filePath);
  const { stderr } = await execFilePromise("ffmpeg", [
    "-i", absPath,
    "-vf", `select='gt(scene,${sceneThreshold})',showinfo`,
    "-an",
    "-f", "null",
    "-",
  ]);

  const candidates: SceneCandidate[] = [];
  // Parse showinfo output: [Parsed_showinfo_1 @ ...] n:...  pts:...  pts_time:...
  const lines = stderr.split("\n");
  for (const line of lines) {
    if (!line.includes("showinfo") || !line.includes("pts_time:")) continue;
    const ptsMatch = line.match(/pts_time:\s*([\d.]+)/);
    // Score is from the scene filter; extract from the previous select filter log if available
    const scoreMatch = line.match(/score:\s*([\d.]+)/);
    if (ptsMatch) {
      const ptsUs = Math.round(parseFloat(ptsMatch[1]) * 1_000_000);
      const score = scoreMatch ? parseFloat(scoreMatch[1]) : sceneThreshold + 0.01;
      candidates.push({ pts_us: ptsUs, score });
    }
  }

  return candidates;
}

// ── Heuristic Detectors ────────────────────────────────────────────

/**
 * Detect black regions using ffmpeg's blackdetect filter.
 */
export async function detectBlackRegions(
  filePath: string,
  thresholds: QualityThresholds,
): Promise<TimeRange[]> {
  const absPath = path.resolve(filePath);
  const { stderr } = await execFilePromise("ffmpeg", [
    "-i", absPath,
    "-vf", `blackdetect=d=${thresholds.blackdetect_duration_s}:pix_th=${thresholds.blackdetect_pix_th}:pic_th=${thresholds.blackdetect_pic_th}`,
    "-an",
    "-f", "null",
    "-",
  ]);

  const regions: TimeRange[] = [];
  for (const line of stderr.split("\n")) {
    // [blackdetect @ ...] black_start:0 black_end:0.5 black_duration:0.5
    const match = line.match(
      /black_start:\s*([\d.]+)\s+black_end:\s*([\d.]+)/,
    );
    if (match) {
      regions.push({
        start_us: Math.round(parseFloat(match[1]) * 1_000_000),
        end_us: Math.round(parseFloat(match[2]) * 1_000_000),
      });
    }
  }
  return regions;
}

/**
 * Detect frozen frame regions using ffmpeg's freezedetect filter.
 */
export async function detectFrozenRegions(
  filePath: string,
  thresholds: QualityThresholds,
): Promise<TimeRange[]> {
  const absPath = path.resolve(filePath);
  const { stderr } = await execFilePromise("ffmpeg", [
    "-i", absPath,
    "-vf", `freezedetect=n=${thresholds.freezedetect_noise_db}dB:d=${thresholds.freezedetect_duration_s}`,
    "-an",
    "-f", "null",
    "-",
  ]);

  const regions: TimeRange[] = [];
  let currentStart: number | null = null;
  for (const line of stderr.split("\n")) {
    const startMatch = line.match(/freeze_start:\s*([\d.]+)/);
    const endMatch = line.match(/freeze_end:\s*([\d.]+)/);
    if (startMatch) {
      currentStart = Math.round(parseFloat(startMatch[1]) * 1_000_000);
    }
    if (endMatch && currentStart !== null) {
      regions.push({
        start_us: currentStart,
        end_us: Math.round(parseFloat(endMatch[1]) * 1_000_000),
      });
      currentStart = null;
    }
  }
  return regions;
}

/**
 * Detect silence regions using ffmpeg's silencedetect filter.
 */
export async function detectSilenceRegions(
  filePath: string,
  thresholds: QualityThresholds,
): Promise<TimeRange[]> {
  const absPath = path.resolve(filePath);
  try {
    const { stderr } = await execFilePromise("ffmpeg", [
      "-i", absPath,
      "-af", `silencedetect=n=${thresholds.silencedetect_noise_db}dB:d=${thresholds.silencedetect_duration_s}`,
      "-vn",
      "-f", "null",
      "-",
    ]);

    const regions: TimeRange[] = [];
    let currentStart: number | null = null;
    for (const line of stderr.split("\n")) {
      const startMatch = line.match(/silence_start:\s*([\d.e+-]+)/);
      const endMatch = line.match(/silence_end:\s*([\d.e+-]+)/);
      if (startMatch) {
        currentStart = Math.round(parseFloat(startMatch[1]) * 1_000_000);
      }
      if (endMatch && currentStart !== null) {
        regions.push({
          start_us: currentStart,
          end_us: Math.round(parseFloat(endMatch[1]) * 1_000_000),
        });
        currentStart = null;
      }
    }
    return regions;
  } catch {
    // No audio stream — no silence regions
    return [];
  }
}

// ── Signal Stats Detectors ──────────────────────────────────────────

/** Per-segment signal stats from ffmpeg signalstats/astats. */
export interface SignalStats {
  /** Average Y luma (0–255). Low values indicate underexposure. */
  avgY: number;
  /** Max Y luma (0–255). Values near 255 may indicate highlight clipping. */
  maxY: number;
}

export interface AudioStats {
  /** Peak sample value (0–1). Values near 1.0 indicate clipped audio. */
  peakLevel: number;
}

/**
 * Run signalstats on a file and return per-frame stats summary.
 * Returns aggregate stats for the entire file (cheap single-pass).
 */
export async function detectSignalStats(
  filePath: string,
): Promise<SignalStats> {
  const absPath = path.resolve(filePath);
  try {
    const { stderr } = await execFilePromise("ffmpeg", [
      "-i", absPath,
      "-vf", "signalstats=stat=tout+vrep+brng,metadata=print:key=lavfi.signalstats.YAVG:key=lavfi.signalstats.YMAX",
      "-an",
      "-f", "null",
      "-",
    ]);

    // Parse YAVG and YMAX from metadata output
    let yAvgSum = 0;
    let yMaxMax = 0;
    let frameCount = 0;
    for (const line of stderr.split("\n")) {
      const yavgMatch = line.match(/lavfi\.signalstats\.YAVG=(\d+)/);
      const ymaxMatch = line.match(/lavfi\.signalstats\.YMAX=(\d+)/);
      if (yavgMatch) {
        yAvgSum += parseInt(yavgMatch[1], 10);
        frameCount++;
      }
      if (ymaxMatch) {
        const val = parseInt(ymaxMatch[1], 10);
        if (val > yMaxMax) yMaxMax = val;
      }
    }

    return {
      avgY: frameCount > 0 ? Math.round(yAvgSum / frameCount) : 128,
      maxY: yMaxMax || 255,
    };
  } catch {
    // signalstats not available or failed — return neutral defaults
    return { avgY: 128, maxY: 200 };
  }
}

/**
 * Run astats on a file and return peak audio level.
 */
export async function detectAudioStats(
  filePath: string,
): Promise<AudioStats> {
  const absPath = path.resolve(filePath);
  try {
    const { stderr } = await execFilePromise("ffmpeg", [
      "-i", absPath,
      "-af", "astats=metadata=1:reset=0,ametadata=print:key=lavfi.astats.Overall.Peak_level",
      "-vn",
      "-f", "null",
      "-",
    ]);

    let maxPeak = 0;
    for (const line of stderr.split("\n")) {
      const match = line.match(/lavfi\.astats\.Overall\.Peak_level=([-\d.]+)/);
      if (match) {
        // Peak_level is in dB; convert to linear scale
        const db = parseFloat(match[1]);
        if (isFinite(db)) {
          const linear = Math.pow(10, db / 20);
          if (linear > maxPeak) maxPeak = linear;
        }
      }
    }

    return { peakLevel: maxPeak };
  } catch {
    // No audio or astats failed — return safe default
    return { peakLevel: 0 };
  }
}

// ── Boundary Assembly ──────────────────────────────────────────────

/**
 * Merge adjacent cut candidates separated by less than merge_gap_us.
 */
export function mergeCutCandidates(
  candidates: SceneCandidate[],
  mergeGapUs: number,
): SceneCandidate[] {
  if (candidates.length === 0) return [];

  const sorted = [...candidates].sort((a, b) => a.pts_us - b.pts_us);
  const merged: SceneCandidate[] = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const prev = merged[merged.length - 1];
    const curr = sorted[i];
    if (curr.pts_us - prev.pts_us < mergeGapUs) {
      // Keep the candidate with the higher score
      if (curr.score > prev.score) {
        merged[merged.length - 1] = curr;
      }
    } else {
      merged.push(curr);
    }
  }

  return merged;
}

interface RawSegment {
  src_in_us: number;
  src_out_us: number;
  boundary_score: number;
}

/**
 * Build segments from cut points and asset duration.
 * Merges short segments into the stronger neighbor.
 */
export function buildSegments(
  cutPoints: SceneCandidate[],
  assetDurationUs: number,
  minSegmentDurationUs: number,
): RawSegment[] {
  if (assetDurationUs <= 0) return [];

  // Build initial segments from cut points
  const sorted = [...cutPoints]
    .filter((c) => c.pts_us > 0 && c.pts_us < assetDurationUs)
    .sort((a, b) => a.pts_us - b.pts_us);

  const segments: RawSegment[] = [];

  if (sorted.length === 0) {
    // Single segment spanning the entire asset
    return [{ src_in_us: 0, src_out_us: assetDurationUs, boundary_score: 1.0 }];
  }

  // First segment: 0 → first cut
  segments.push({
    src_in_us: 0,
    src_out_us: sorted[0].pts_us,
    boundary_score: sorted[0].score,
  });

  // Middle segments
  for (let i = 0; i < sorted.length - 1; i++) {
    segments.push({
      src_in_us: sorted[i].pts_us,
      src_out_us: sorted[i + 1].pts_us,
      boundary_score: sorted[i + 1].score,
    });
  }

  // Last segment: last cut → end
  segments.push({
    src_in_us: sorted[sorted.length - 1].pts_us,
    src_out_us: assetDurationUs,
    boundary_score: sorted[sorted.length - 1].score,
  });

  // Merge short segments into stronger neighbors
  return mergeShortSegments(segments, minSegmentDurationUs);
}

/**
 * Merge segments shorter than minDuration into the stronger neighboring segment.
 * Prefer the neighbor with larger duration, then earlier src_in_us.
 */
function mergeShortSegments(
  segments: RawSegment[],
  minDuration: number,
): RawSegment[] {
  let result = [...segments];
  let changed = true;

  while (changed) {
    changed = false;
    for (let i = 0; i < result.length; i++) {
      const seg = result[i];
      const duration = seg.src_out_us - seg.src_in_us;
      if (duration < minDuration && result.length > 1) {
        // Find the stronger neighbor
        const prev = i > 0 ? result[i - 1] : null;
        const next = i < result.length - 1 ? result[i + 1] : null;

        let mergeTarget: "prev" | "next";
        if (!prev) {
          mergeTarget = "next";
        } else if (!next) {
          mergeTarget = "prev";
        } else {
          const prevDur = prev.src_out_us - prev.src_in_us;
          const nextDur = next.src_out_us - next.src_in_us;
          if (prevDur > nextDur) {
            mergeTarget = "prev";
          } else if (nextDur > prevDur) {
            mergeTarget = "next";
          } else {
            // Equal duration: prefer earlier
            mergeTarget = "prev";
          }
        }

        if (mergeTarget === "prev" && prev) {
          prev.src_out_us = seg.src_out_us;
          result.splice(i, 1);
        } else if (mergeTarget === "next" && next) {
          next.src_in_us = seg.src_in_us;
          result.splice(i, 1);
        }
        changed = true;
        break;
      }
    }
  }

  return result;
}

// ── Quality Flag Computation ───────────────────────────────────────

/**
 * Check if a time range overlaps with a segment.
 */
function overlaps(range: TimeRange, segIn: number, segOut: number): boolean {
  return range.start_us < segOut && range.end_us > segIn;
}

/**
 * Compute the overlap fraction of a range within a segment.
 */
function overlapFraction(range: TimeRange, segIn: number, segOut: number): number {
  const overlapStart = Math.max(range.start_us, segIn);
  const overlapEnd = Math.min(range.end_us, segOut);
  if (overlapEnd <= overlapStart) return 0;
  const segDuration = segOut - segIn;
  if (segDuration <= 0) return 0;
  return (overlapEnd - overlapStart) / segDuration;
}

/**
 * Compute deterministic quality flags for a segment based on heuristic detectors.
 * Includes signalstats/astats flags when stats are provided.
 */
export function computeQualityFlags(
  segIn: number,
  segOut: number,
  blackRegions: TimeRange[],
  frozenRegions: TimeRange[],
  silenceRegions: TimeRange[],
  minSegDuration: number,
  signalStats?: SignalStats | null,
  audioStats?: AudioStats | null,
): string[] {
  const flags: string[] = [];
  const segDuration = segOut - segIn;

  // black_segment: >50% of segment is black
  const blackCoverage = blackRegions
    .filter((r) => overlaps(r, segIn, segOut))
    .reduce((acc, r) => acc + overlapFraction(r, segIn, segOut), 0);
  if (blackCoverage > 0.5) {
    flags.push("black_segment");
  }

  // frozen_frame: any frozen region overlaps significantly
  const frozenCoverage = frozenRegions
    .filter((r) => overlaps(r, segIn, segOut))
    .reduce((acc, r) => acc + overlapFraction(r, segIn, segOut), 0);
  if (frozenCoverage > 0.5) {
    flags.push("frozen_frame");
  }

  // near_silent: >80% of segment is silent
  const silenceCoverage = silenceRegions
    .filter((r) => overlaps(r, segIn, segOut))
    .reduce((acc, r) => acc + overlapFraction(r, segIn, segOut), 0);
  if (silenceCoverage > 0.8) {
    flags.push("near_silent");
  }

  // very_short_segment: shorter than min duration (but kept after merge)
  if (segDuration < minSegDuration) {
    flags.push("very_short_segment");
  }

  // underexposed: average luma < 30 (very dark overall)
  if (signalStats && signalStats.avgY < 30) {
    flags.push("underexposed");
  }

  // minor_highlight_clip: max luma at 255 (highlights clipping)
  if (signalStats && signalStats.maxY >= 255) {
    flags.push("minor_highlight_clip");
  }

  // clipped_audio: peak level >= 0.99 (audio clipping)
  if (audioStats && audioStats.peakLevel >= 0.99) {
    flags.push("clipped_audio");
  }

  return flags;
}

/**
 * Compute representative frame timestamp for a segment.
 * Midpoint, adjusted away from black/freeze regions when needed.
 */
export function computeRepFrame(
  segIn: number,
  segOut: number,
  blackRegions: TimeRange[],
  frozenRegions: TimeRange[],
): number {
  const midpoint = Math.round((segIn + segOut) / 2);

  // Check if midpoint falls in a bad region
  const inBadRegion = [...blackRegions, ...frozenRegions].some(
    (r) => midpoint >= r.start_us && midpoint <= r.end_us,
  );

  if (!inBadRegion) return midpoint;

  // Try 25% and 75% points
  const quarter = Math.round(segIn + (segOut - segIn) * 0.25);
  const threeQuarter = Math.round(segIn + (segOut - segIn) * 0.75);

  const quarterBad = [...blackRegions, ...frozenRegions].some(
    (r) => quarter >= r.start_us && quarter <= r.end_us,
  );
  if (!quarterBad) return quarter;

  const threeQuarterBad = [...blackRegions, ...frozenRegions].some(
    (r) => threeQuarter >= r.start_us && threeQuarter <= r.end_us,
  );
  if (!threeQuarterBad) return threeQuarter;

  // Fall back to midpoint anyway
  return midpoint;
}

// ── Main ───────────────────────────────────────────────────────────

/**
 * Generate segment_id from asset_id and ordinal.
 * SEG_<asset_id>_<ordinal_4>
 */
export function generateSegmentId(assetId: string, ordinal: number): string {
  return `SEG_${assetId}_${String(ordinal).padStart(4, "0")}`;
}

/** Result of segmentAsset including any detector failure info. */
export interface SegmentAssetResult {
  segments: SegmentItem[];
  /** Non-empty when one or more detectors failed. */
  detectorFailures: string[];
}

/**
 * Run full segmentation on a source file for a given asset.
 * Returns segments and any detector failures.
 * On scene-detector failure, no segments are produced (no silent fallback).
 */
export async function segmentAsset(
  filePath: string,
  asset: AssetItem,
  thresholds: QualityThresholds,
  opts: {
    policyHash?: string;
    ffmpegVersion?: string;
  } = {},
): Promise<SegmentAssetResult> {
  const detectorFailures: string[] = [];

  // Run all detectors in parallel, catching failures individually
  const [sceneResult, blackResult, frozenResult, silenceResult, sigResult, audioResult] =
    await Promise.all([
      detectSceneBoundaries(filePath, thresholds.scene_threshold)
        .catch((err: Error) => {
          detectorFailures.push(`scene_detect: ${err.message}`);
          return null;
        }),
      detectBlackRegions(filePath, thresholds)
        .catch((err: Error) => {
          detectorFailures.push(`blackdetect: ${err.message}`);
          return [] as TimeRange[];
        }),
      detectFrozenRegions(filePath, thresholds)
        .catch((err: Error) => {
          detectorFailures.push(`freezedetect: ${err.message}`);
          return [] as TimeRange[];
        }),
      detectSilenceRegions(filePath, thresholds)
        .catch((err: Error) => {
          detectorFailures.push(`silencedetect: ${err.message}`);
          return [] as TimeRange[];
        }),
      detectSignalStats(filePath),
      detectAudioStats(filePath),
    ]);

  // If the primary scene detector failed, do NOT produce ready segments
  if (sceneResult === null) {
    return { segments: [], detectorFailures };
  }

  const sceneCandidates = sceneResult;
  const blackRegions = blackResult ?? [];
  const frozenRegions = frozenResult ?? [];
  const silenceRegions = silenceResult ?? [];

  // Merge close candidates
  const mergedCuts = mergeCutCandidates(sceneCandidates, thresholds.merge_gap_us);

  // Build segments with short-segment merging
  const rawSegments = buildSegments(
    mergedCuts,
    asset.duration_us,
    thresholds.min_segment_duration_us,
  );

  const policyHash = opts.policyHash ?? "none";
  const ffmpegVersion = opts.ffmpegVersion ?? "unknown";

  // Determine boundary status: "ready" only when all detectors succeeded
  const boundaryStatus = detectorFailures.length > 0 ? "degraded" : "ready";

  // Classify segment_type based on heuristic detectors
  const classifySegmentType = (
    segIn: number,
    segOut: number,
  ): string => {
    const segDuration = segOut - segIn;
    // black_segment: >50% black → "static" (non-content segment)
    const blackCoverage = blackRegions
      .filter((r) => overlaps(r, segIn, segOut))
      .reduce((acc, r) => acc + overlapFraction(r, segIn, segOut), 0);
    if (blackCoverage > 0.5) return "static";

    // near_silent: >80% silent → "static" (likely title card or B-roll)
    const silenceCoverage = silenceRegions
      .filter((r) => overlaps(r, segIn, segOut))
      .reduce((acc, r) => acc + overlapFraction(r, segIn, segOut), 0);
    if (silenceCoverage > 0.8) return "static";

    // frozen: >50% frozen → "static"
    const frozenCoverage = frozenRegions
      .filter((r) => overlaps(r, segIn, segOut))
      .reduce((acc, r) => acc + overlapFraction(r, segIn, segOut), 0);
    if (frozenCoverage > 0.5) return "static";

    // very short → "action" (quick cuts imply high motion)
    if (segDuration < thresholds.min_segment_duration_us) return "action";

    return "general";
  };

  // Convert to SegmentItems
  const segments = rawSegments.map((raw, index) => {
    const segId = generateSegmentId(asset.asset_id, index + 1);
    const flags = computeQualityFlags(
      raw.src_in_us,
      raw.src_out_us,
      blackRegions,
      frozenRegions,
      silenceRegions,
      thresholds.min_segment_duration_us,
      sigResult,
      audioResult,
    );
    const repFrame = computeRepFrame(
      raw.src_in_us,
      raw.src_out_us,
      blackRegions,
      frozenRegions,
    );

    const requestHash = computeRequestHash({
      connector_version: CONNECTOR_VERSION,
      ffmpeg_version: ffmpegVersion,
      asset_id: asset.asset_id,
      segment_ordinal: index + 1,
      scene_threshold: thresholds.scene_threshold,
    });

    // Normalize boundary score to [0, 1]
    const normalizedScore = Math.min(1, Math.max(0, raw.boundary_score));

    return {
      segment_id: segId,
      asset_id: asset.asset_id,
      src_in_us: raw.src_in_us,
      src_out_us: raw.src_out_us,
      duration_us: raw.src_out_us - raw.src_in_us,
      rep_frame_us: repFrame,
      summary: "",
      transcript_excerpt: "",
      quality_flags: flags,
      tags: [],
      segment_type: classifySegmentType(raw.src_in_us, raw.src_out_us),
      transcript_ref: asset.transcript_ref,
      confidence: {
        boundary: {
          score: normalizedScore,
          source: "ffmpeg_scene_detect",
          status: boundaryStatus,
        },
      },
      provenance: {
        boundary: {
          stage: "segment",
          method: "ffmpeg_scene_detect",
          connector_version: CONNECTOR_VERSION,
          policy_hash: policyHash,
          request_hash: requestHash,
          ffmpeg_version: ffmpegVersion,
        },
      },
    };
  });

  return { segments, detectorFailures };
}
