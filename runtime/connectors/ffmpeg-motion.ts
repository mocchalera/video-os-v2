/**
 * ffmpeg-based Motion Detection — supplementary signal for peak confidence.
 *
 * Per vlm-peak-detection-design.md §12:
 * - Computes per-bin motion energy score within a segment
 * - Provides motion_support_score for VLM peak confidence fusion
 * - No remote API calls — pure local ffmpeg analysis
 * - Injectable for testing
 */

// ── Types ──────────────────────────────────────────────────────────

export interface MotionBin {
  /** Bin start timestamp in microseconds */
  start_us: number;
  /** Bin end timestamp in microseconds */
  end_us: number;
  /** Normalized motion energy score (0-1) */
  energy: number;
}

export interface MotionAnalysisResult {
  /** Per-bin motion energy scores */
  bins: MotionBin[];
  /** Overall segment motion energy (average) */
  average_energy: number;
  /** Peak motion energy in the segment */
  peak_energy: number;
  /** Timestamp of peak motion energy in microseconds */
  peak_timestamp_us: number;
}

/** Injectable function for running ffmpeg signalstats analysis. */
export type MotionAnalyzeFn = (
  sourcePath: string,
  srcInUs: number,
  srcOutUs: number,
  binCount: number,
) => Promise<MotionAnalysisResult>;

// ── Motion Support Score ───────────────────────────────────────────

/**
 * Compute the motion support score for a VLM peak.
 * Checks if there is a local motion maximum near the peak timestamp.
 *
 * @param bins - Motion energy bins for the segment
 * @param peakTimestampUs - VLM-detected peak timestamp
 * @param windowMs - Search window around the peak (default 500ms)
 * @returns motion support score (0-1)
 */
export function computeMotionSupportScore(
  bins: MotionBin[],
  peakTimestampUs: number,
  windowMs: number = 500,
): number {
  if (bins.length === 0) return 0.5; // Neutral when no data

  const windowUs = windowMs * 1000;
  const searchStart = peakTimestampUs - windowUs;
  const searchEnd = peakTimestampUs + windowUs;

  // Find max energy in the search window
  let maxEnergyInWindow = 0;
  let maxEnergyOverall = 0;

  for (const bin of bins) {
    const binMid = (bin.start_us + bin.end_us) / 2;
    if (bin.energy > maxEnergyOverall) {
      maxEnergyOverall = bin.energy;
    }
    if (binMid >= searchStart && binMid <= searchEnd) {
      if (bin.energy > maxEnergyInWindow) {
        maxEnergyInWindow = bin.energy;
      }
    }
  }

  if (maxEnergyOverall <= 0) return 0.5; // Neutral for no-motion segments

  // Support score is how close the local max is to the global max
  return maxEnergyInWindow / maxEnergyOverall;
}

// ── Stub Motion Analyzer (for testing / when ffmpeg is not available) ──

/**
 * Create a stub motion analyzer that returns uniform energy.
 * Used when ffmpeg is not available or for testing.
 */
export function createStubMotionAnalyzeFn(defaultEnergy: number = 0.5): MotionAnalyzeFn {
  return async (
    _sourcePath: string,
    srcInUs: number,
    srcOutUs: number,
    binCount: number,
  ): Promise<MotionAnalysisResult> => {
    const duration = srcOutUs - srcInUs;
    const binDuration = duration / binCount;
    const bins: MotionBin[] = [];

    for (let i = 0; i < binCount; i++) {
      bins.push({
        start_us: srcInUs + Math.floor(binDuration * i),
        end_us: srcInUs + Math.floor(binDuration * (i + 1)),
        energy: defaultEnergy,
      });
    }

    return {
      bins,
      average_energy: defaultEnergy,
      peak_energy: defaultEnergy,
      peak_timestamp_us: Math.floor((srcInUs + srcOutUs) / 2),
    };
  };
}
