// Timeline agreement — how closely a candidate timeline.json agrees
// with the golden cut: clip usage, cut order, trim points, total
// duration, and beat structure.

import type { ClipOutput, TimelineIR } from "../artifacts/types.js";
import {
  clamp01,
  jaccard,
  longestIncreasingSubsequenceLength,
  matchSegments,
} from "./matching.js";
import type { MatchableSegment, TimelineAgreementReport } from "./types.js";

/** Tolerances that map raw deviations onto 0..1 scores. */
const CUT_IN_TOLERANCE_US = 2_000_000; // 2s trim drift = score 0
const DURATION_TOLERANCE_SEC = 2; // 2s clip-length drift = score 0
const TOTAL_DURATION_TOLERANCE_PCT = 0.2; // ±20% total length = score 0

interface FlatClip {
  clip: ClipOutput;
  order: number;
}

function fps(timeline: TimelineIR): number {
  return timeline.sequence.fps_num / (timeline.sequence.fps_den || 1);
}

/** Flatten video-track clips in timeline order (V1 first, then upper tracks). */
function flattenVideoClips(timeline: TimelineIR): FlatClip[] {
  const clips: ClipOutput[] = [];
  for (const track of timeline.tracks.video ?? []) {
    clips.push(...track.clips);
  }
  clips.sort((a, b) => a.timeline_in_frame - b.timeline_in_frame);
  return clips.map((clip, order) => ({ clip, order }));
}

function toMatchable(fc: FlatClip): MatchableSegment {
  return {
    // Occurrence-unique id so repeated segments match one-to-one.
    id: `${fc.clip.segment_id}#${fc.order}`,
    asset_id: fc.clip.asset_id,
    src_in_us: fc.clip.src_in_us,
    src_out_us: fc.clip.src_out_us,
  };
}

function totalDurationFrames(flat: FlatClip[]): number {
  let end = 0;
  for (const fc of flat) {
    end = Math.max(end, fc.clip.timeline_in_frame + fc.clip.timeline_duration_frames);
  }
  return end;
}

/** Per-beat share of total duration, keyed by beat_id. */
function beatDurationShares(flat: FlatClip[]): Map<string, number> {
  const byBeat = new Map<string, number>();
  let total = 0;
  for (const fc of flat) {
    const frames = fc.clip.timeline_duration_frames;
    byBeat.set(fc.clip.beat_id, (byBeat.get(fc.clip.beat_id) ?? 0) + frames);
    total += frames;
  }
  if (total > 0) {
    for (const [beat, frames] of byBeat) byBeat.set(beat, frames / total);
  }
  return byBeat;
}

export function evaluateTimelineAgreement(
  golden: TimelineIR,
  candidate: TimelineIR,
): TimelineAgreementReport {
  const goldenFlat = flattenVideoClips(golden);
  const candidateFlat = flattenVideoClips(candidate);

  const goldenByKey = new Map(goldenFlat.map((fc) => [toMatchable(fc).id, fc]));
  const candidateByKey = new Map(candidateFlat.map((fc) => [toMatchable(fc).id, fc]));

  const match = matchSegments(
    goldenFlat.map(toMatchable),
    candidateFlat.map(toMatchable),
  );

  const matchedCount = match.pairs.length;
  const precision = candidateFlat.length > 0 ? matchedCount / candidateFlat.length : 0;
  const recall = goldenFlat.length > 0 ? matchedCount / goldenFlat.length : 0;
  const usageF1 =
    precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;

  // ── Order agreement: LIS of candidate positions in golden order ──
  let orderAgreement: number | null = null;
  if (matchedCount >= 2) {
    const sorted = [...match.pairs].sort(
      (a, b) =>
        (goldenByKey.get(a.golden.id)?.order ?? 0) -
        (goldenByKey.get(b.golden.id)?.order ?? 0),
    );
    const candidateOrders = sorted.map(
      (p) => candidateByKey.get(p.candidate.id)?.order ?? 0,
    );
    orderAgreement = longestIncreasingSubsequenceLength(candidateOrders) / matchedCount;
  } else if (matchedCount === 1) {
    orderAgreement = 1;
  }

  // ── Trim deviations over matched pairs ────────────────────────────
  let meanCutInDevUs: number | null = null;
  let meanDurationDevFrames: number | null = null;
  if (matchedCount > 0) {
    let cutSum = 0;
    let durSum = 0;
    for (const pair of match.pairs) {
      const g = goldenByKey.get(pair.golden.id)?.clip;
      const c = candidateByKey.get(pair.candidate.id)?.clip;
      if (!g || !c) continue;
      cutSum += Math.abs(g.src_in_us - c.src_in_us);
      durSum += Math.abs(g.timeline_duration_frames - c.timeline_duration_frames);
    }
    meanCutInDevUs = cutSum / matchedCount;
    meanDurationDevFrames = durSum / matchedCount;
  }

  // ── Total duration ────────────────────────────────────────────────
  const goldenTotal = totalDurationFrames(goldenFlat);
  const candidateTotal = totalDurationFrames(candidateFlat);
  const totalDurationDevPct =
    goldenTotal > 0 ? Math.abs(goldenTotal - candidateTotal) / goldenTotal : 0;

  // ── Beat structure ────────────────────────────────────────────────
  let beatStructureScore: number | null = null;
  const goldenShares = beatDurationShares(goldenFlat);
  const candidateShares = beatDurationShares(candidateFlat);
  if (goldenShares.size > 0 || candidateShares.size > 0) {
    const beatJaccard = jaccard(
      new Set(goldenShares.keys()),
      new Set(candidateShares.keys()),
    );
    const commonBeats = [...goldenShares.keys()].filter((b) => candidateShares.has(b));
    let shareScore = 0;
    if (commonBeats.length > 0) {
      const meanShareDev =
        commonBeats.reduce(
          (s, b) => s + Math.abs((goldenShares.get(b) ?? 0) - (candidateShares.get(b) ?? 0)),
          0,
        ) / commonBeats.length;
      // A 25% share drift on average zeroes the share component.
      shareScore = clamp01(1 - meanShareDev / 0.25);
    }
    beatStructureScore = clamp01(beatJaccard * 0.5 + shareScore * 0.5);
  }

  // ── Composite ─────────────────────────────────────────────────────
  const goldenFps = fps(golden) || 24;
  const cutScore =
    meanCutInDevUs !== null ? clamp01(1 - meanCutInDevUs / CUT_IN_TOLERANCE_US) : null;
  const durationScore =
    meanDurationDevFrames !== null
      ? clamp01(1 - meanDurationDevFrames / (DURATION_TOLERANCE_SEC * goldenFps))
      : null;
  const totalDurationScore = clamp01(1 - totalDurationDevPct / TOTAL_DURATION_TOLERANCE_PCT);

  const parts: Array<{ value: number; weight: number }> = [
    { value: usageF1, weight: 0.35 },
    { value: totalDurationScore, weight: 0.1 },
  ];
  if (orderAgreement !== null) parts.push({ value: orderAgreement, weight: 0.25 });
  if (cutScore !== null) parts.push({ value: cutScore, weight: 0.1 });
  if (durationScore !== null) parts.push({ value: durationScore, weight: 0.05 });
  if (beatStructureScore !== null) parts.push({ value: beatStructureScore, weight: 0.15 });
  const totalWeight = parts.reduce((s, p) => s + p.weight, 0);
  const score = clamp01(parts.reduce((s, p) => s + p.value * p.weight, 0) / totalWeight);

  return {
    golden_clip_count: goldenFlat.length,
    candidate_clip_count: candidateFlat.length,
    matched_clip_count: matchedCount,
    clip_usage_f1: usageF1,
    order_agreement: orderAgreement,
    mean_cut_in_deviation_us: meanCutInDevUs,
    mean_duration_deviation_frames: meanDurationDevFrames,
    total_duration_deviation_pct: totalDurationDevPct,
    beat_structure_score: beatStructureScore,
    score,
  };
}
