import type { Candidate, ClipOutput, SelectsCandidates, TimelineIR } from "../artifacts/types.js";
import {
  searchFootage,
  type SearchFootageInput,
  type FootageSearchResponse,
  type FootageSearchResult,
} from "../tools/footage-search.js";
import type { QAIssue } from "./qa-issue-detector.js";
import { primaryVideoClips } from "./qa-issue-detector.js";

export type QAFixType = "swap" | "reorder" | "trim" | "insert" | "remove";
export type QAFixRisk = "low" | "medium" | "high";
export type QAFixSearchMode = "visual" | "audio" | "hybrid";

export interface QAFix {
  issue_id: string;
  issue: QAIssue;
  fix_type: QAFixType;
  target_clip_id: string;
  target_beat_id: string;
  replacement?: {
    segment_id: string;
    search_mode: QAFixSearchMode;
    search_score: number;
    matched_frame_path?: string;
    reason: string;
  };
  expected_improvement: number;
  risk: QAFixRisk;
}

export type QAFixSearchFn = (
  projectDir: string,
  input: SearchFootageInput,
) => Promise<FootageSearchResponse>;

export interface ProposeFixesOptions {
  maxFixes?: number;
  minImprovement?: number;
  minQualityScore?: number;
  searchLimit?: number;
  search?: QAFixSearchFn;
}

interface ReplacementChoice {
  result: FootageSearchResult;
  candidate: Candidate;
  qualityScore: number;
}

const DEFAULT_MAX_FIXES = 5;
const DEFAULT_MIN_IMPROVEMENT = 0.1;
const DEFAULT_MIN_QUALITY_SCORE = 0.5;
const DEFAULT_SEARCH_LIMIT = 8;

export async function proposeFixes(
  issues: QAIssue[],
  timeline: TimelineIR,
  selects: SelectsCandidates,
  projectDir: string,
  opts: ProposeFixesOptions = {},
): Promise<QAFix[]> {
  const search = opts.search ?? searchFootage;
  const minQualityScore = opts.minQualityScore ?? DEFAULT_MIN_QUALITY_SCORE;
  const searchLimit = opts.searchLimit ?? DEFAULT_SEARCH_LIMIT;
  const maxFixes = opts.maxFixes ?? DEFAULT_MAX_FIXES;
  const minImprovement = opts.minImprovement ?? DEFAULT_MIN_IMPROVEMENT;

  const proposed: QAFix[] = [];
  for (const issue of [...issues].filter((item) => item.fixable).sort(compareIssuesForProposal)) {
    const fix = await proposeFixForIssue(issue, timeline, selects, projectDir, {
      search,
      minQualityScore,
      searchLimit,
    });
    if (!fix) continue;
    if (fix.expected_improvement < minImprovement) continue;
    proposed.push(fix);
  }

  const selected: QAFix[] = [];
  const usedTargets = new Set<string>();
  const usedReplacements = new Set<string>();
  for (const fix of proposed.sort(compareFixes)) {
    if (usedTargets.has(fix.target_clip_id)) continue;
    const replacementId = fix.replacement?.segment_id;
    if (replacementId && usedReplacements.has(replacementId)) continue;
    selected.push(fix);
    usedTargets.add(fix.target_clip_id);
    if (replacementId) usedReplacements.add(replacementId);
    if (selected.length >= maxFixes) break;
  }

  return selected;
}

async function proposeFixForIssue(
  issue: QAIssue,
  timeline: TimelineIR,
  selects: SelectsCandidates,
  projectDir: string,
  options: Required<Pick<ProposeFixesOptions, "search" | "minQualityScore" | "searchLimit">>,
): Promise<QAFix | null> {
  if (issue.type === "continuity") {
    return proposeContinuityFix(issue, timeline, selects, projectDir, options);
  }
  if (issue.type === "must_have") {
    return proposeSearchFix("swap", "hybrid", issue, timeline, selects, projectDir, options);
  }
  if (issue.type === "variety") {
    return proposeSearchFix("swap", "hybrid", issue, timeline, selects, projectDir, options);
  }
  if (issue.type === "pacing" && issue.suggested_fix_type !== "swap") {
    return proposeTrimFix(issue, timeline, selects);
  }
  if (issue.suggested_fix_type === "swap" || issue.type === "quality") {
    return proposeSearchFix("swap", "visual", issue, timeline, selects, projectDir, options);
  }
  return null;
}

async function proposeSearchFix(
  fixType: Extract<QAFixType, "swap">,
  searchMode: Extract<QAFixSearchMode, "visual" | "hybrid">,
  issue: QAIssue,
  timeline: TimelineIR,
  selects: SelectsCandidates,
  projectDir: string,
  options: Required<Pick<ProposeFixesOptions, "search" | "minQualityScore" | "searchLimit">>,
): Promise<QAFix | null> {
  const targetClip = targetClipForIssue(issue, timeline);
  if (!targetClip) return null;
  const excluded = timelineSegmentIds(timeline);
  const input = searchInputForIssue(issue, targetClip, searchMode, excluded, options);
  const response = await options.search(projectDir, input);
  const replacement = issue.type === "variety"
    ? chooseVarietyReplacement(response.results, timeline, selects, excluded, options.minQualityScore)
    : chooseReplacement(response.results, selects, excluded, options.minQualityScore);
  if (!replacement) return null;

  const risk = classifyRisk(fixType, issue, targetClip, replacement.candidate);
  const expected = expectedReplacementImprovement(issue, replacement, selects, targetClip, fixType);
  return {
    issue_id: issue.issue_id,
    issue,
    fix_type: fixType,
    target_clip_id: targetClip.clip_id,
    target_beat_id: issue.beat_id ?? targetClip.beat_id,
    replacement: {
      segment_id: replacement.result.segment_id,
      search_mode: searchMode,
      search_score: round3(scoreForResult(replacement.result)),
      ...(replacement.result.key_frame_path ? { matched_frame_path: replacement.result.key_frame_path } : {}),
      reason: replacement.result.match_reason || issue.description,
    },
    expected_improvement: expected,
    risk,
  };
}

async function proposeContinuityFix(
  issue: QAIssue,
  timeline: TimelineIR,
  selects: SelectsCandidates,
  projectDir: string,
  options: Required<Pick<ProposeFixesOptions, "search" | "minQualityScore" | "searchLimit">>,
): Promise<QAFix | null> {
  const leftClip = issue.adjacent_clip_ids?.before
    ? clipById(timeline, issue.adjacent_clip_ids.before)
    : undefined;
  const rightClip = issue.adjacent_clip_ids?.after
    ? clipById(timeline, issue.adjacent_clip_ids.after)
    : undefined;
  if (!leftClip || !rightClip) return null;

  const excluded = timelineSegmentIds(timeline);
  const baseInput = {
    query: issue.search_query ?? issue.description,
    mode: "visual" as const,
    visual_goal: "match_cut" as const,
    filters: {
      exclude_segment_ids: excluded,
      quality_min: { composition_score: options.minQualityScore },
    },
    limit: options.searchLimit,
  };
  const [leftResponse, rightResponse] = await Promise.all([
    options.search(projectDir, {
      ...baseInput,
      visual_anchor: { segment_id: leftClip.segment_id, frame_type: "visual_representative" },
    }),
    options.search(projectDir, {
      ...baseInput,
      visual_anchor: { segment_id: rightClip.segment_id, frame_type: "visual_representative" },
    }),
  ]);

  const merged = mergeBridgeResults(leftResponse.results, rightResponse.results);
  const replacement = chooseReplacement(merged, selects, excluded, options.minQualityScore);
  if (!replacement) return null;

  const risk = classifyRisk("insert", issue, leftClip, replacement.candidate);
  const expected = expectedReplacementImprovement(issue, replacement, selects, leftClip, "insert");
  return {
    issue_id: issue.issue_id,
    issue,
    fix_type: "insert",
    target_clip_id: leftClip.clip_id,
    target_beat_id: issue.beat_id ?? leftClip.beat_id,
    replacement: {
      segment_id: replacement.result.segment_id,
      search_mode: "visual",
      search_score: round3(scoreForResult(replacement.result)),
      ...(replacement.result.key_frame_path ? { matched_frame_path: replacement.result.key_frame_path } : {}),
      reason: replacement.result.match_reason || `Bridge visual continuity between ${leftClip.clip_id} and ${rightClip.clip_id}`,
    },
    expected_improvement: expected,
    risk,
  };
}

function proposeTrimFix(
  issue: QAIssue,
  timeline: TimelineIR,
  selects: SelectsCandidates,
): QAFix | null {
  const targetClip = targetClipForIssue(issue, timeline);
  if (!targetClip) return null;
  const risk = classifyRisk("trim", issue, targetClip, candidateForSegment(selects, targetClip.segment_id));
  const expected = round3(clamp01(0.55 * issue.severity + 0.1));
  return {
    issue_id: issue.issue_id,
    issue,
    fix_type: "trim",
    target_clip_id: targetClip.clip_id,
    target_beat_id: issue.beat_id ?? targetClip.beat_id,
    expected_improvement: expected,
    risk,
  };
}

function searchInputForIssue(
  issue: QAIssue,
  targetClip: ClipOutput,
  searchMode: Extract<QAFixSearchMode, "visual" | "hybrid">,
  excluded: string[],
  options: Required<Pick<ProposeFixesOptions, "minQualityScore" | "searchLimit">>,
): SearchFootageInput {
  const query = issue.search_query ?? targetClip.motivation ?? issue.description;
  if (searchMode === "visual") {
    return {
      query,
      mode: "visual",
      visual_anchor: { segment_id: targetClip.segment_id, frame_type: "visual_representative" },
      filters: {
        exclude_segment_ids: excluded,
        quality_min: { composition_score: options.minQualityScore },
      },
      limit: options.searchLimit,
    };
  }
  return {
    query,
    semantic: query,
    mode: "hybrid",
    filters: {
      exclude_segment_ids: excluded,
      quality_min: { composition_score: options.minQualityScore },
    },
    limit: options.searchLimit,
  };
}

function chooseReplacement(
  results: FootageSearchResult[],
  selects: SelectsCandidates,
  excludedSegmentIds: string[],
  minQualityScore: number,
): ReplacementChoice | null {
  const excluded = new Set(excludedSegmentIds);
  const candidateBySegment = new Map(
    selects.candidates
      .filter((candidate) => candidate.role !== "reject")
      .map((candidate) => [candidate.segment_id, candidate]),
  );

  for (const result of [...results].sort(compareResults)) {
    if (excluded.has(result.segment_id)) continue;
    const candidate = candidateBySegment.get(result.segment_id);
    if (!candidate) continue;
    const qualityScore = qualityScoreForResult(result, candidate);
    if (qualityScore < minQualityScore) continue;
    return { result, candidate, qualityScore };
  }
  return null;
}

function chooseVarietyReplacement(
  results: FootageSearchResult[],
  timeline: TimelineIR,
  selects: SelectsCandidates,
  excludedSegmentIds: string[],
  minQualityScore: number,
): ReplacementChoice | null {
  const excluded = new Set(excludedSegmentIds);
  const selectedAssetIds = new Set(primaryVideoClips(timeline).map((clip) => clip.asset_id));
  const selectedClusters = selectedSemanticClusters(timeline, selects);
  const candidateBySegment = new Map(
    selects.candidates
      .filter((candidate) => candidate.role !== "reject")
      .map((candidate) => [candidate.segment_id, candidate]),
  );
  const choices = results.flatMap((result) => {
    if (excluded.has(result.segment_id)) return [];
    const candidate = candidateBySegment.get(result.segment_id);
    if (!candidate) return [];
    const qualityScore = qualityScoreForResult(result, candidate);
    if (qualityScore < minQualityScore) return [];
    return [{
      result,
      candidate,
      qualityScore,
      noveltyScore: visualNoveltyScore(result, candidate, selectedAssetIds, selectedClusters),
    }];
  });

  return choices.sort((left, right) =>
    right.noveltyScore - left.noveltyScore
    || right.qualityScore - left.qualityScore
    || compareResults(left.result, right.result)
  )[0] ?? null;
}

function mergeBridgeResults(
  leftResults: FootageSearchResult[],
  rightResults: FootageSearchResult[],
): FootageSearchResult[] {
  const rightBySegment = new Map(rightResults.map((result) => [result.segment_id, result]));
  return leftResults
    .flatMap((left) => {
      const right = rightBySegment.get(left.segment_id);
      if (!right) return [];
      const score = harmonicMean(scoreForResult(left), scoreForResult(right));
      return [{
        ...left,
        score,
        scores: {
          ...left.scores,
          final: score,
          qwen_visual: harmonicMean(left.scores.qwen_visual ?? scoreForResult(left), right.scores.qwen_visual ?? scoreForResult(right)),
        },
        match_reason: [left.match_reason, right.match_reason].filter(Boolean).join(" / "),
      }];
    })
    .sort(compareResults);
}

function targetClipForIssue(issue: QAIssue, timeline: TimelineIR): ClipOutput | undefined {
  if (issue.clip_id) {
    const direct = clipById(timeline, issue.clip_id);
    if (direct) return direct;
  }
  const clips = primaryVideoClips(timeline);
  if (issue.beat_id) {
    const inBeat = clips.find((clip) => clip.beat_id === issue.beat_id);
    if (inBeat) return inBeat;
  }
  return clips[0];
}

function clipById(timeline: TimelineIR, clipId: string): ClipOutput | undefined {
  return primaryVideoClips(timeline).find((clip) => clip.clip_id === clipId);
}

function timelineSegmentIds(timeline: TimelineIR): string[] {
  return Array.from(new Set(primaryVideoClips(timeline).map((clip) => clip.segment_id))).sort();
}

function candidateForSegment(selects: SelectsCandidates, segmentId: string): Candidate | undefined {
  return selects.candidates.find((candidate) => candidate.segment_id === segmentId && candidate.role !== "reject");
}

function selectedSemanticClusters(timeline: TimelineIR, selects: SelectsCandidates): Set<string> {
  return new Set(
    primaryVideoClips(timeline)
      .map((clip) => candidateForSegment(selects, clip.segment_id)?.editorial_signals?.semantic_cluster_id)
      .filter((cluster): cluster is string => Boolean(cluster)),
  );
}

function visualNoveltyScore(
  result: FootageSearchResult,
  candidate: Candidate,
  selectedAssetIds: Set<string>,
  selectedClusters: Set<string>,
): number {
  const cluster = candidate.editorial_signals?.semantic_cluster_id;
  const qwenSimilarity = typeof result.scores.qwen_visual === "number" ? clamp01(result.scores.qwen_visual) : undefined;
  return clamp01(
    (selectedAssetIds.has(result.asset_id) ? 0 : 0.45)
    + (cluster && !selectedClusters.has(cluster) ? 0.35 : 0)
    + (qwenSimilarity === undefined ? 0.1 : 0.2 * (1 - qwenSimilarity)),
  );
}

function expectedReplacementImprovement(
  issue: QAIssue,
  replacement: ReplacementChoice,
  selects: SelectsCandidates,
  targetClip: ClipOutput,
  fixType: QAFixType,
): number {
  const targetCandidate = candidateForSegment(selects, targetClip.segment_id);
  const targetQuality = targetCandidate?.confidence ?? 0.5;
  const qualityGain = Math.max(0, replacement.qualityScore - targetQuality);
  const typeBonus = fixType === "insert" ? 0.05 : fixType === "swap" ? 0.08 : 0;
  return round3(clamp01(
    0.35 * issue.severity
    + 0.42 * scoreForResult(replacement.result)
    + 0.15 * qualityGain
    + typeBonus,
  ));
}

function classifyRisk(
  fixType: QAFixType,
  issue: QAIssue,
  targetClip: ClipOutput,
  replacement?: Candidate,
): QAFixRisk {
  if (fixType === "trim" || fixType === "remove") return "low";
  if (fixType === "insert" || fixType === "reorder") return "medium";
  if (targetClip.role === "hero" && issue.type !== "quality") return "high";
  if (!replacement) return "medium";
  const sameBeat = replacement.eligible_beats?.includes(targetClip.beat_id) ?? false;
  const sameRole = replacement.role === targetClip.role;
  return sameBeat && sameRole ? "low" : "medium";
}

function qualityScoreForResult(result: FootageSearchResult, candidate: Candidate): number {
  const qualityValues = Object.values(result.quality ?? {})
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (qualityValues.length > 0) {
    return clamp01(qualityValues.reduce((total, value) => total + value, 0) / qualityValues.length);
  }
  if (typeof result.scores.quality === "number" && Number.isFinite(result.scores.quality)) {
    return clamp01(result.scores.quality);
  }
  if (typeof candidate.confidence === "number" && Number.isFinite(candidate.confidence)) {
    return clamp01(candidate.confidence);
  }
  return clamp01(scoreForResult(result));
}

function compareFixes(left: QAFix, right: QAFix): number {
  return rankFix(right) - rankFix(left)
    || right.expected_improvement - left.expected_improvement
    || left.target_clip_id.localeCompare(right.target_clip_id)
    || (left.replacement?.segment_id ?? "").localeCompare(right.replacement?.segment_id ?? "")
    || left.issue_id.localeCompare(right.issue_id);
}

function compareIssuesForProposal(left: QAIssue, right: QAIssue): number {
  return right.severity - left.severity
    || left.timestamp_sec - right.timestamp_sec
    || (left.clip_id ?? "").localeCompare(right.clip_id ?? "")
    || left.issue_id.localeCompare(right.issue_id);
}

function compareResults(left: FootageSearchResult, right: FootageSearchResult): number {
  return scoreForResult(right) - scoreForResult(left)
    || left.segment_id.localeCompare(right.segment_id);
}

function rankFix(fix: QAFix): number {
  return fix.expected_improvement * (1 - riskPenalty(fix.risk));
}

function riskPenalty(risk: QAFixRisk): number {
  if (risk === "high") return 0.35;
  if (risk === "medium") return 0.15;
  return 0;
}

function scoreForResult(result: FootageSearchResult): number {
  const value = typeof result.score === "number" && Number.isFinite(result.score)
    ? result.score
    : result.scores.final;
  return clamp01(value);
}

function harmonicMean(left: number, right: number): number {
  const a = clamp01(left);
  const b = clamp01(right);
  if (a <= 0 || b <= 0) return 0;
  return (2 * a * b) / (a + b);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
