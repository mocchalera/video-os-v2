import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const VISUAL_COMPOSITE_TEMPORAL_CORRESPONDENCE_VERSION =
  "visual-composite-temporal-correspondence/v2" as const;

/** Default fail-closed threshold: more than one frame of lead/lag is a hard failure. */
export const DEFAULT_TEMPORAL_CORRESPONDENCE_THRESHOLD_FRAMES = 1;

export type VisualCompositeTemporalCorrespondenceVerdict =
  | "pass"
  | "fail"
  | "unobservable";

export interface VisualCompositeTemporalCorrespondenceResult {
  version: typeof VISUAL_COMPOSITE_TEMPORAL_CORRESPONDENCE_VERSION;
  base_path: string;
  output_path: string;
  width: number;
  height: number;
  probe_width: number;
  probe_height: number;
  base_frame_count: number;
  output_frame_count: number;
  sample_start_frame: number;
  sample_end_frame: number;
  sample_stride: number;
  sample_count: number;
  /** Number of distinct base frames in the equally supported sample set. */
  base_distinct_sample_frame_count: number;
  /** Caller-requested radius before it was constrained to equal sample support. */
  requested_search_radius_frames: number;
  /** Effective radius whose candidates all use the same sample_count. */
  search_radius_frames: number;
  best_offset_frames: number | null;
  /**
   * Meaning: output[i] ≈ base[i + best_offset_frames].
   * Positive offset => output leads base (shows later base content early).
   */
  best_mean_abs_diff: number | null;
  same_index_mean_abs_diff: number | null;
  threshold_frames: number;
  verdict: VisualCompositeTemporalCorrespondenceVerdict;
  pass: boolean;
  /**
   * Kept for the existing compositor caller. true means the probe could not
   * be extracted; a completed but unobservable measurement remains false so
   * its current assertion stays fail-closed.
   */
  skipped: boolean;
  /** @deprecated Use unobservable_reason with verdict="unobservable". */
  skip_reason?: string;
  unobservable_reason?: string;
  interpretation: string;
}

/** Minimum frames required for a meaningful offset search. */
export const MIN_TEMPORAL_CORRESPONDENCE_FRAMES = 8;
/** Minimum equally supported samples required for every offset candidate. */
export const MIN_TEMPORAL_CORRESPONDENCE_SAMPLES = 4;

export interface MeasureVisualTemporalCorrespondenceOptions {
  baseVideoPath: string;
  outputVideoPath: string;
  /** Full-frame geometry is not required; probes are downscaled. */
  probeWidth?: number;
  probeHeight?: number;
  /** Restrict offset search; default covers multi-second still openers. */
  searchRadiusFrames?: number;
  sampleStartFrame?: number;
  sampleEndFrame?: number;
  sampleStride?: number;
  thresholdFrames?: number;
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { maxBuffer: 64 * 1024 * 1024 }, (error, _stdout, stderr) => {
      if (error) {
        reject(new Error(`${command} failed: ${stderr || error.message}`));
        return;
      }
      resolve();
    });
  });
}

async function extractGraySequence(
  videoPath: string,
  probeWidth: number,
  probeHeight: number,
  outPath: string,
): Promise<number> {
  await run("ffmpeg", [
    "-y",
    "-i", videoPath,
    "-an",
    "-vf", `scale=${probeWidth}:${probeHeight}:flags=fast_bilinear,format=gray`,
    "-f", "rawvideo",
    "-pix_fmt", "gray",
    outPath,
  ]);
  if (!fs.existsSync(outPath)) return 0;
  const bytes = fs.statSync(outPath).size;
  const frameBytes = probeWidth * probeHeight;
  if (bytes < frameBytes) return 0;
  if (bytes % frameBytes !== 0) {
    throw new Error(
      `temporal_correspondence_probe_corrupt: path=${videoPath} bytes=${bytes} frame_bytes=${frameBytes}`,
    );
  }
  return bytes / frameBytes;
}

interface UnobservableResultDetails {
  reason: string;
  baseFrames?: number;
  outputFrames?: number;
  sampleStart?: number;
  sampleEnd?: number;
  sampleStride?: number;
  sampleCount?: number;
  baseDistinctSampleFrameCount?: number;
  requestedSearchRadiusFrames?: number;
  searchRadiusFrames?: number;
  skipped?: boolean;
}

function unobservableResult(
  options: MeasureVisualTemporalCorrespondenceOptions,
  probeWidth: number,
  probeHeight: number,
  thresholdFrames: number,
  details: UnobservableResultDetails,
): VisualCompositeTemporalCorrespondenceResult {
  return {
    version: VISUAL_COMPOSITE_TEMPORAL_CORRESPONDENCE_VERSION,
    base_path: path.resolve(options.baseVideoPath),
    output_path: path.resolve(options.outputVideoPath),
    width: probeWidth,
    height: probeHeight,
    probe_width: probeWidth,
    probe_height: probeHeight,
    base_frame_count: details.baseFrames ?? 0,
    output_frame_count: details.outputFrames ?? 0,
    sample_start_frame: details.sampleStart ?? 0,
    sample_end_frame: details.sampleEnd ?? 0,
    sample_stride: details.sampleStride ?? 1,
    sample_count: details.sampleCount ?? 0,
    base_distinct_sample_frame_count: details.baseDistinctSampleFrameCount ?? 0,
    requested_search_radius_frames: details.requestedSearchRadiusFrames ?? 0,
    search_radius_frames: details.searchRadiusFrames ?? 0,
    best_offset_frames: null,
    best_mean_abs_diff: null,
    same_index_mean_abs_diff: null,
    threshold_frames: thresholdFrames,
    verdict: "unobservable",
    pass: false,
    skipped: details.skipped ?? false,
    skip_reason: details.reason,
    unobservable_reason: details.reason,
    interpretation: `unobservable: ${details.reason}`,
  };
}

function meanAbsDiff(
  a: Buffer,
  b: Buffer,
  offsetA: number,
  offsetB: number,
  length: number,
): number {
  let sum = 0;
  for (let i = 0; i < length; i += 1) {
    sum += Math.abs(a[offsetA + i]! - b[offsetB + i]!);
  }
  return sum / length;
}

interface ComparableSampleSet {
  sampleFrames: number[];
  searchRadiusFrames: number;
}

function findComparableSampleSet(options: {
  sampleStart: number;
  sampleEnd: number;
  sampleStride: number;
  baseFrames: number;
  outputFrames: number;
  requestedSearchRadiusFrames: number;
}): ComparableSampleSet | null {
  const maxSearchRadius = Math.min(
    options.requestedSearchRadiusFrames,
    Math.max(0, options.baseFrames - 1),
  );
  for (let searchRadiusFrames = maxSearchRadius; searchRadiusFrames >= 0; searchRadiusFrames -= 1) {
    const sampleFrames: number[] = [];
    for (
      let frame = options.sampleStart;
      frame < options.sampleEnd;
      frame += options.sampleStride
    ) {
      if (
        frame < searchRadiusFrames
        || frame >= options.outputFrames
        || frame + searchRadiusFrames >= options.baseFrames
      ) {
        continue;
      }
      sampleFrames.push(frame);
    }
    if (sampleFrames.length >= MIN_TEMPORAL_CORRESPONDENCE_SAMPLES) {
      return { sampleFrames, searchRadiusFrames };
    }
  }
  return null;
}

function countDistinctFrames(
  buffer: Buffer,
  sampleFrames: readonly number[],
  frameBytes: number,
): number {
  const distinctFrames: Buffer[] = [];
  for (const frame of sampleFrames) {
    const start = frame * frameBytes;
    const candidate = buffer.subarray(start, start + frameBytes);
    if (!distinctFrames.some((distinct) => distinct.equals(candidate))) {
      distinctFrames.push(candidate);
    }
  }
  return distinctFrames.length;
}

export function interpretTemporalOffset(offsetFrames: number): string {
  if (offsetFrames === 0) {
    return "output frame i corresponds to base frame i (no measurable lead/lag)";
  }
  if (offsetFrames > 0) {
    return `output leads base by ${offsetFrames} frame(s); output[i] matches base[i+${offsetFrames}]`;
  }
  return `output lags base by ${-offsetFrames} frame(s); output[i] matches base[i${offsetFrames}]`;
}

/**
 * Deterministic pre/post composite temporal correspondence probe.
 * Stream duration equality alone is never treated as lip-sync proof.
 */
export async function measureVisualTemporalCorrespondence(
  options: MeasureVisualTemporalCorrespondenceOptions,
): Promise<VisualCompositeTemporalCorrespondenceResult> {
  const probeWidth = options.probeWidth ?? 36;
  const probeHeight = options.probeHeight ?? 64;
  const thresholdFrames =
    options.thresholdFrames ?? DEFAULT_TEMPORAL_CORRESPONDENCE_THRESHOLD_FRAMES;
  const searchRadiusFrames = options.searchRadiusFrames ?? 96;
  if (!Number.isInteger(probeWidth) || probeWidth <= 0) {
    throw new Error(`temporal_correspondence_invalid_probe_width:${probeWidth}`);
  }
  if (!Number.isInteger(probeHeight) || probeHeight <= 0) {
    throw new Error(`temporal_correspondence_invalid_probe_height:${probeHeight}`);
  }
  if (!Number.isInteger(thresholdFrames) || thresholdFrames < 0) {
    throw new Error(`temporal_correspondence_invalid_threshold:${thresholdFrames}`);
  }
  if (!Number.isInteger(searchRadiusFrames) || searchRadiusFrames < 0) {
    throw new Error(`temporal_correspondence_invalid_search_radius:${searchRadiusFrames}`);
  }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "vos-temporal-corr-"));
  try {
    const baseGray = path.join(workDir, "base.gray");
    const outGray = path.join(workDir, "out.gray");
    const baseFrames = await extractGraySequence(
      options.baseVideoPath, probeWidth, probeHeight, baseGray,
    );
    const outputFrames = await extractGraySequence(
      options.outputVideoPath, probeWidth, probeHeight, outGray,
    );
    if (
      baseFrames < MIN_TEMPORAL_CORRESPONDENCE_FRAMES
      || outputFrames < MIN_TEMPORAL_CORRESPONDENCE_FRAMES
    ) {
      return unobservableResult(
        options,
        probeWidth,
        probeHeight,
        thresholdFrames,
        {
          reason: `insufficient_frames base=${baseFrames} output=${outputFrames} min=${MIN_TEMPORAL_CORRESPONDENCE_FRAMES}`,
          baseFrames,
          outputFrames,
          requestedSearchRadiusFrames: searchRadiusFrames,
          skipped: true,
        },
      );
    }

    const baseBuf = fs.readFileSync(baseGray);
    const outBuf = fs.readFileSync(outGray);
    const frameBytes = probeWidth * probeHeight;

    const sampleStart = options.sampleStartFrame
      ?? Math.min(Math.floor(Math.min(baseFrames, outputFrames) * 0.15), Math.max(0, Math.min(baseFrames, outputFrames) - 8));
    const sampleEnd = options.sampleEndFrame
      ?? Math.max(sampleStart + 1, Math.floor(Math.min(baseFrames, outputFrames) * 0.8));
    const sampleStride = options.sampleStride ?? 4;
    if (!Number.isInteger(sampleStart) || sampleStart < 0) {
      throw new Error(`temporal_correspondence_invalid_sample_start:${sampleStart}`);
    }
    if (!Number.isInteger(sampleEnd) || sampleEnd <= sampleStart) {
      throw new Error(`temporal_correspondence_invalid_sample_end:${sampleEnd}`);
    }
    if (!Number.isInteger(sampleStride) || sampleStride <= 0) {
      throw new Error(`temporal_correspondence_invalid_sample_stride:${sampleStride}`);
    }

    const comparableSamples = findComparableSampleSet({
      sampleStart,
      sampleEnd,
      sampleStride,
      baseFrames,
      outputFrames,
      requestedSearchRadiusFrames: searchRadiusFrames,
    });
    if (!comparableSamples) {
      return unobservableResult(
        options,
        probeWidth,
        probeHeight,
        thresholdFrames,
        {
          reason: `insufficient_equally_supported_samples min=${MIN_TEMPORAL_CORRESPONDENCE_SAMPLES}`,
          baseFrames,
          outputFrames,
          sampleStart,
          sampleEnd,
          sampleStride,
          requestedSearchRadiusFrames: searchRadiusFrames,
        },
      );
    }

    const { sampleFrames, searchRadiusFrames: effectiveSearchRadiusFrames } = comparableSamples;
    const distinctBaseSampleFrameCount = countDistinctFrames(
      baseBuf,
      sampleFrames,
      frameBytes,
    );
    if (distinctBaseSampleFrameCount < 2) {
      return unobservableResult(
        options,
        probeWidth,
        probeHeight,
        thresholdFrames,
        {
          reason: `insufficient_temporal_discriminability distinct_base_sample_frames=${distinctBaseSampleFrameCount}`,
          baseFrames,
          outputFrames,
          sampleStart,
          sampleEnd,
          sampleStride,
          sampleCount: sampleFrames.length,
          baseDistinctSampleFrameCount: distinctBaseSampleFrameCount,
          requestedSearchRadiusFrames: searchRadiusFrames,
          searchRadiusFrames: effectiveSearchRadiusFrames,
        },
      );
    }

    let bestOffset = 0;
    let bestMad = Number.POSITIVE_INFINITY;
    let sameIndexMad = Number.POSITIVE_INFINITY;

    for (
      let offset = -effectiveSearchRadiusFrames;
      offset <= effectiveSearchRadiusFrames;
      offset += 1
    ) {
      let sum = 0;
      for (const i of sampleFrames) {
        const j = i + offset;
        sum += meanAbsDiff(outBuf, baseBuf, i * frameBytes, j * frameBytes, frameBytes);
      }
      const mad = sum / sampleFrames.length;
      if (offset === 0) {
        sameIndexMad = mad;
      }
      if (
        mad < bestMad
        || (
          mad === bestMad
          && (
            Math.abs(offset) < Math.abs(bestOffset)
            || (Math.abs(offset) === Math.abs(bestOffset) && offset < bestOffset)
          )
        )
      ) {
        bestMad = mad;
        bestOffset = offset;
      }
    }

    if (!Number.isFinite(bestMad)) {
      return unobservableResult(
        options,
        probeWidth,
        probeHeight,
        thresholdFrames,
        {
          reason: "no_equally_supported_samples",
          baseFrames,
          outputFrames,
          sampleStart,
          sampleEnd,
          sampleStride,
          sampleCount: sampleFrames.length,
          baseDistinctSampleFrameCount: distinctBaseSampleFrameCount,
          requestedSearchRadiusFrames: searchRadiusFrames,
          searchRadiusFrames: effectiveSearchRadiusFrames,
        },
      );
    }

    const pass = Math.abs(bestOffset) <= thresholdFrames;
    return {
      version: VISUAL_COMPOSITE_TEMPORAL_CORRESPONDENCE_VERSION,
      base_path: path.resolve(options.baseVideoPath),
      output_path: path.resolve(options.outputVideoPath),
      width: probeWidth,
      height: probeHeight,
      probe_width: probeWidth,
      probe_height: probeHeight,
      base_frame_count: baseFrames,
      output_frame_count: outputFrames,
      sample_start_frame: sampleStart,
      sample_end_frame: sampleEnd,
      sample_stride: sampleStride,
      sample_count: sampleFrames.length,
      base_distinct_sample_frame_count: distinctBaseSampleFrameCount,
      requested_search_radius_frames: searchRadiusFrames,
      search_radius_frames: effectiveSearchRadiusFrames,
      best_offset_frames: bestOffset,
      best_mean_abs_diff: Number(bestMad.toFixed(6)),
      same_index_mean_abs_diff: Number(
        (Number.isFinite(sameIndexMad) ? sameIndexMad : bestMad).toFixed(6),
      ),
      threshold_frames: thresholdFrames,
      verdict: pass ? "pass" : "fail",
      pass,
      skipped: false,
      interpretation: interpretTemporalOffset(bestOffset),
    };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

export function assertVisualTemporalCorrespondence(
  result: VisualCompositeTemporalCorrespondenceResult,
): void {
  if (result.verdict === "pass" && result.pass) return;
  if (result.verdict === "unobservable") {
    throw new Error(
      `visual_composite_temporal_correspondence_unobservable: reason=${result.unobservable_reason ?? result.skip_reason ?? "unknown"} `
        + `sample_count=${result.sample_count} base_distinct_sample_frames=${result.base_distinct_sample_frame_count}`,
    );
  }
  throw new Error(
    `visual_composite_temporal_correspondence_failed: offset_frames=${result.best_offset_frames} `
      + `threshold_frames=${result.threshold_frames} same_index_mad=${result.same_index_mean_abs_diff} `
      + `best_mad=${result.best_mean_abs_diff} (${result.interpretation})`,
  );
}

export function writeVisualTemporalCorrespondenceEvidence(
  result: VisualCompositeTemporalCorrespondenceResult,
  evidencePath: string,
): string {
  fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
  fs.writeFileSync(evidencePath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return evidencePath;
}
