// Segment/clip matching primitives shared by the agreement metrics.
//
// Matching strategy: exact id match first (segment ids are stable across
// runs when 03_analysis is frozen), then greedy temporal-IoU matching
// within the same asset. The temporal fallback lets the eval tolerate
// re-trimmed windows of the same underlying moment.

import type {
  MatchableSegment,
  SegmentMatchPair,
  SegmentMatchResult,
} from "./types.js";

export const DEFAULT_IOU_THRESHOLD = 0.3;

export function temporalIou(a: MatchableSegment, b: MatchableSegment): number {
  if (a.asset_id !== b.asset_id) return 0;
  const interIn = Math.max(a.src_in_us, b.src_in_us);
  const interOut = Math.min(a.src_out_us, b.src_out_us);
  const intersection = Math.max(0, interOut - interIn);
  const union =
    Math.max(a.src_out_us, b.src_out_us) - Math.min(a.src_in_us, b.src_in_us);
  if (union <= 0) return 0;
  return intersection / union;
}

/**
 * Match golden items to candidate items: exact id first, then greedy
 * max-IoU within the same asset. Each item matches at most once.
 */
export function matchSegments(
  golden: MatchableSegment[],
  candidate: MatchableSegment[],
  iouThreshold = DEFAULT_IOU_THRESHOLD,
): SegmentMatchResult {
  const pairs: SegmentMatchPair[] = [];
  const usedCandidate = new Set<number>();
  const usedGolden = new Set<number>();

  // Pass 1: exact id matches (first unused occurrence wins).
  for (let gi = 0; gi < golden.length; gi += 1) {
    const g = golden[gi];
    for (let ci = 0; ci < candidate.length; ci += 1) {
      if (usedCandidate.has(ci)) continue;
      const c = candidate[ci];
      if (c.id === g.id) {
        pairs.push({ golden: g, candidate: c, kind: "exact", iou: temporalIou(g, c) });
        usedGolden.add(gi);
        usedCandidate.add(ci);
        break;
      }
    }
  }

  // Pass 2: greedy temporal matching among the leftovers.
  interface IouEntry {
    gi: number;
    ci: number;
    iou: number;
  }
  const entries: IouEntry[] = [];
  for (let gi = 0; gi < golden.length; gi += 1) {
    if (usedGolden.has(gi)) continue;
    for (let ci = 0; ci < candidate.length; ci += 1) {
      if (usedCandidate.has(ci)) continue;
      const iou = temporalIou(golden[gi], candidate[ci]);
      if (iou >= iouThreshold) {
        entries.push({ gi, ci, iou });
      }
    }
  }
  entries.sort((a, b) => b.iou - a.iou);
  for (const entry of entries) {
    if (usedGolden.has(entry.gi) || usedCandidate.has(entry.ci)) continue;
    pairs.push({
      golden: golden[entry.gi],
      candidate: candidate[entry.ci],
      kind: "temporal",
      iou: entry.iou,
    });
    usedGolden.add(entry.gi);
    usedCandidate.add(entry.ci);
  }

  return {
    pairs,
    unmatched_golden: golden.filter((_, i) => !usedGolden.has(i)),
    unmatched_candidate: candidate.filter((_, i) => !usedCandidate.has(i)),
  };
}

// ── Sequence helpers ────────────────────────────────────────────────

/**
 * Length of the longest strictly-increasing subsequence. Used to score
 * cut-order agreement: matched pairs sorted by golden position should
 * appear in increasing candidate position when the order is preserved.
 */
export function longestIncreasingSubsequenceLength(values: number[]): number {
  const tails: number[] = [];
  for (const v of values) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (tails[mid] < v) lo = mid + 1;
      else hi = mid;
    }
    tails[lo] = v;
  }
  return tails.length;
}

/** LCS length over two string sequences (for story-role agreement). */
export function longestCommonSubsequenceLength(a: string[], b: string[]): number {
  const dp: number[] = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    let prev = 0;
    for (let j = 1; j <= b.length; j += 1) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev + 1 : Math.max(dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return dp[b.length];
}

/** Spearman rank correlation; null when fewer than 3 samples. */
export function spearmanCorrelation(xs: number[], ys: number[]): number | null {
  if (xs.length !== ys.length || xs.length < 3) return null;
  const rank = (vals: number[]): number[] => {
    const indexed = vals.map((v, i) => ({ v, i }));
    indexed.sort((a, b) => a.v - b.v);
    const ranks = new Array<number>(vals.length);
    let i = 0;
    while (i < indexed.length) {
      let j = i;
      while (j + 1 < indexed.length && indexed[j + 1].v === indexed[i].v) j += 1;
      const avgRank = (i + j) / 2 + 1;
      for (let k = i; k <= j; k += 1) ranks[indexed[k].i] = avgRank;
      i = j + 1;
    }
    return ranks;
  };
  const rx = rank(xs);
  const ry = rank(ys);
  const n = xs.length;
  const meanX = rx.reduce((s, v) => s + v, 0) / n;
  const meanY = ry.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let denX = 0;
  let denY = 0;
  for (let k = 0; k < n; k += 1) {
    const dx = rx[k] - meanX;
    const dy = ry[k] - meanY;
    num += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  }
  const den = Math.sqrt(denX * denY);
  if (den === 0) return null;
  return num / den;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const v of a) if (b.has(v)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

export function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}
