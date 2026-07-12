import type { CreativeBrief, SelectsCandidates } from "../artifacts/types.js";
import { searchFootage, type FootageSearchResult } from "../tools/footage-search.js";

export type RetrievalEvidenceSource = "brief.must_have" | "brief.editorial.policy_hint";
export type RetrievalChannel = "visual" | "audio";

export interface RetrievalSearchInput {
  query: string;
  semantic: string;
  mode: "hybrid";
  limit: number;
}

export interface VisualRetrievalResult {
  segment_id: string;
  asset_id: string;
  src_in_us: number;
  src_out_us: number;
  summary: string;
  score: number;
  score_breakdown: {
    qwen_visual?: number;
    qwen_text?: number;
    e5_text?: number;
    lexical?: number;
    final: number;
  };
  matched_frame_path?: string;
  matched_embedding_type?: string;
  tags?: string[];
}

export interface VisualRetrievalEvidence {
  query_id: string;
  source: RetrievalEvidenceSource;
  query: string;
  channel?: "visual";
  search_input: RetrievalSearchInput;
  mode: "hybrid";
  results: VisualRetrievalResult[];
  warnings: string[];
}

export interface AudioRetrievalResult {
  segment_id: string;
  asset_id: string;
  src_in_us: number;
  src_out_us: number;
  summary: string;
  score: number;
  score_breakdown: {
    audio_similarity?: number;
    qwen_text?: number;
    e5_text?: number;
    lexical?: number;
    final: number;
  };
  matched_audio_ref?: string;
  matched_embedding_type?: string;
  tags?: string[];
}

export interface AudioRetrievalEvidence {
  query_id: string;
  source: RetrievalEvidenceSource;
  query: string;
  channel: "audio";
  search_input: RetrievalSearchInput;
  mode: "hybrid";
  results: AudioRetrievalResult[];
  warnings: string[];
}

export type RetrievalEvidence = VisualRetrievalEvidence | AudioRetrievalEvidence;
export type RetrievalResult = VisualRetrievalResult | AudioRetrievalResult;

export interface VisualRetrievalTrace {
  project_id: string;
  timestamp: string;
  queries: Array<{
    query_id: string;
    source: RetrievalEvidenceSource;
    channel: RetrievalChannel;
    query: string;
    search_input: RetrievalSearchInput;
    result_count: number;
    results: RetrievalResult[];
    warnings: string[];
  }>;
  total_unique_segments: number;
  selected_linkage?: VisualRetrievalSelectedLinkage[];
  warnings: string[];
}

export interface VisualRetrievalSelectedLinkage {
  segment_id: string;
  query_ids: string[];
  best_qwen_visual: number;
  best_final: number;
}

export interface VisualRetrievalQuery {
  query_id: string;
  source: RetrievalEvidenceSource;
  query: string;
}

export interface AudioRetrievalQuery {
  query_id: string;
  source: RetrievalEvidenceSource;
  query: string;
  channel: "audio";
}

export interface VisualRetrievalOptions {
  limitPerQuery?: number;
  maxTotalResults?: number;
}

export type AudioRetrievalOptions = VisualRetrievalOptions;

const VISUAL_PRIORITY_PREFIX = "Qwen3-VL visual search priority:";
const AUDIO_PRIORITY_PREFIXES = [
  "CLAP audio search priority:",
  "CLAP audio retrieval priority:",
  "Audio search priority:",
  "Audio retrieval priority:",
  "音声検索 priority:",
  "音声検索:",
];
const AUDIO_INTENT_PATTERN =
  /環境音|自然音|原音|音声|音楽|音量|音|声|話し声|BGM|静か|無音|沈黙|余韻|room tone|ambient|ambience|ambiance|natural sound|nat sound|source sound|music|voice|dialogue|sound|noise|quiet|silence|silent|calm|crowd|water|rain|machine/i;
const DEFAULT_LIMIT_PER_QUERY = 8;
const DEFAULT_MAX_TOTAL_RESULTS = 40;
const PROMPT_QUERY_MAX_CHARS = 200;
const PROMPT_SUMMARY_MAX_CHARS = 120;

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function extractPriorityQuery(value: string): string | undefined {
  const index = value.indexOf(VISUAL_PRIORITY_PREFIX);
  if (index < 0) return undefined;
  const query = value.slice(index + VISUAL_PRIORITY_PREFIX.length).trim();
  return query || undefined;
}

function extractAudioPriorityQuery(value: string): string | undefined {
  for (const prefix of AUDIO_PRIORITY_PREFIXES) {
    const index = value.indexOf(prefix);
    if (index < 0) continue;
    const query = value.slice(index + prefix.length).trim();
    if (query) return query;
  }
  return undefined;
}

function audioQueryText(raw: string): string | undefined {
  const explicitAudioQuery = extractAudioPriorityQuery(raw);
  if (explicitAudioQuery) return explicitAudioQuery;

  const visualPriorityQuery = extractPriorityQuery(raw);
  if (visualPriorityQuery) {
    return AUDIO_INTENT_PATTERN.test(visualPriorityQuery) ? visualPriorityQuery : undefined;
  }

  return AUDIO_INTENT_PATTERN.test(raw) ? raw.trim() : undefined;
}

function pushPriorityQuery(
  queries: VisualRetrievalQuery[],
  query_id: string,
  source: VisualRetrievalQuery["source"],
  raw: string,
): void {
  const query = extractPriorityQuery(raw);
  if (!query) return;
  queries.push({ query_id, source, query });
}

function pushAudioQuery(
  queries: AudioRetrievalQuery[],
  query_id: string,
  source: AudioRetrievalQuery["source"],
  raw: string,
): void {
  const query = audioQueryText(raw);
  if (!query) return;
  queries.push({ query_id, source, query, channel: "audio" });
}

function paddedId(prefix: string, index: number): string {
  return `${prefix}_${String(index + 1).padStart(2, "0")}`;
}

export function extractVisualQueries(brief: CreativeBrief): VisualRetrievalQuery[] {
  const record = brief as Record<string, unknown>;
  const queries: VisualRetrievalQuery[] = [];

  stringArray(record.must_have).forEach((item, index) => {
    pushPriorityQuery(queries, paddedId("must_have", index), "brief.must_have", item);
  });

  const editorial = record.editorial;
  const policyHint = editorial && typeof editorial === "object"
    ? (editorial as Record<string, unknown>).policy_hint
    : undefined;
  if (typeof policyHint === "string") {
    policyHint.split(/\r?\n/).forEach((line, index) => {
      pushPriorityQuery(queries, paddedId("policy_hint", index), "brief.editorial.policy_hint", line);
    });
  }

  return queries;
}

export function extractAudioQueries(brief: CreativeBrief): AudioRetrievalQuery[] {
  const record = brief as Record<string, unknown>;
  const queries: AudioRetrievalQuery[] = [];

  stringArray(record.must_have).forEach((item, index) => {
    pushAudioQuery(queries, paddedId("must_have", index), "brief.must_have", item);
  });

  const editorial = record.editorial;
  const policyHint = editorial && typeof editorial === "object"
    ? (editorial as Record<string, unknown>).policy_hint
    : undefined;
  if (typeof policyHint === "string") {
    policyHint.split(/\r?\n/).forEach((line, index) => {
      pushAudioQuery(queries, paddedId("policy_hint", index), "brief.editorial.policy_hint", line);
    });
  }

  return queries;
}

function finiteScore(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function resultFinalScore(result: VisualRetrievalResult): number {
  return result.score_breakdown.final;
}

function resultAudioRankScore(result: AudioRetrievalResult): number {
  return result.score_breakdown.audio_similarity ?? result.score_breakdown.final;
}

function matchedEmbeddingType(result: FootageSearchResult): string | undefined {
  const matches = result.scores.embedding_matches ?? [];
  return matches.find((match) => match.embedding_type.startsWith("visual_"))?.embedding_type
    ?? matches[0]?.embedding_type;
}

function matchedAudioEmbedding(result: FootageSearchResult): { embedding_type?: string; source_ref?: string } {
  const matches = result.scores.embedding_matches ?? [];
  const audioMatch = matches.find((match) =>
    match.embedding_type.startsWith("audio_") || match.embedding_type.includes("clap")
  ) ?? matches[0];
  return {
    ...(audioMatch?.embedding_type ? { embedding_type: audioMatch.embedding_type } : {}),
    ...(audioMatch?.source_ref ? { source_ref: audioMatch.source_ref } : {}),
  };
}

function toVisualResult(result: FootageSearchResult): VisualRetrievalResult | undefined {
  const qwenVisual = finiteScore(result.scores.qwen_visual);
  if (qwenVisual === undefined) return undefined;

  const final = finiteScore(result.scores.final) ?? finiteScore(result.score) ?? qwenVisual;
  return {
    segment_id: result.segment_id,
    asset_id: result.asset_id,
    src_in_us: result.src_in_us,
    src_out_us: result.src_out_us,
    summary: result.summary,
    score: final,
    score_breakdown: {
      qwen_visual: qwenVisual,
      qwen_text: finiteScore(result.scores.qwen_text),
      e5_text: finiteScore(result.scores.e5_text ?? result.scores.semantic),
      lexical: finiteScore(result.scores.lexical),
      final,
    },
    ...(result.key_frame_path ? { matched_frame_path: result.key_frame_path } : {}),
    ...(matchedEmbeddingType(result) ? { matched_embedding_type: matchedEmbeddingType(result) } : {}),
    ...(result.tags.length > 0 ? { tags: result.tags } : {}),
  };
}

function toAudioResult(result: FootageSearchResult): AudioRetrievalResult | undefined {
  const audioSimilarity = finiteScore(result.scores.audio_similarity ?? result.scores.clap_audio);
  if (audioSimilarity === undefined) return undefined;

  const final = finiteScore(result.scores.final) ?? finiteScore(result.score) ?? audioSimilarity;
  const audioMatch = matchedAudioEmbedding(result);
  return {
    segment_id: result.segment_id,
    asset_id: result.asset_id,
    src_in_us: result.src_in_us,
    src_out_us: result.src_out_us,
    summary: result.summary,
    score: final,
    score_breakdown: {
      audio_similarity: audioSimilarity,
      qwen_text: finiteScore(result.scores.qwen_text),
      e5_text: finiteScore(result.scores.e5_text ?? result.scores.semantic),
      lexical: finiteScore(result.scores.lexical),
      final,
    },
    ...(audioMatch.source_ref ? { matched_audio_ref: audioMatch.source_ref } : {}),
    ...(audioMatch.embedding_type ? { matched_embedding_type: audioMatch.embedding_type } : {}),
    ...(result.tags.length > 0 ? { tags: result.tags } : {}),
  };
}

function dedupeWithinQuery<T extends { segment_id: string }>(
  results: T[],
  scoreForSort: (result: T) => number,
): T[] {
  const bestBySegment = new Map<string, T>();
  for (const result of results) {
    const previous = bestBySegment.get(result.segment_id);
    if (!previous || scoreForSort(result) > scoreForSort(previous)) {
      bestBySegment.set(result.segment_id, result);
    }
  }
  return [...bestBySegment.values()].sort((a, b) =>
    scoreForSort(b) - scoreForSort(a) || a.segment_id.localeCompare(b.segment_id)
  );
}

function dedupeAcrossQueries<
  TResult extends { segment_id: string },
  TEvidence extends { results: TResult[] },
>(
  evidence: TEvidence[],
  maxTotalResults: number,
  scoreForSort: (result: TResult) => number,
): TEvidence[] {
  const bestBySegment = new Map<string, {
    evidenceIndex: number;
    resultIndex: number;
    result: TResult;
  }>();

  evidence.forEach((entry, evidenceIndex) => {
    entry.results.forEach((result, resultIndex) => {
      const previous = bestBySegment.get(result.segment_id);
      const nextScore = scoreForSort(result);
      const previousScore = previous ? scoreForSort(previous.result) : -Infinity;
      if (!previous || nextScore > previousScore) {
        bestBySegment.set(result.segment_id, { evidenceIndex, resultIndex, result });
      }
    });
  });

  const kept = new Set(
    [...bestBySegment.values()]
      .sort((a, b) =>
        scoreForSort(b.result) - scoreForSort(a.result)
        || a.evidenceIndex - b.evidenceIndex
        || a.resultIndex - b.resultIndex
        || a.result.segment_id.localeCompare(b.result.segment_id)
      )
      .slice(0, maxTotalResults)
      .map((entry) => `${entry.evidenceIndex}:${entry.result.segment_id}`),
  );

  return evidence.map((entry, evidenceIndex) => ({
    ...entry,
    results: entry.results
      .filter((result) => kept.has(`${evidenceIndex}:${result.segment_id}`))
      .sort((a, b) => scoreForSort(b) - scoreForSort(a) || a.segment_id.localeCompare(b.segment_id)),
  })) as TEvidence[];
}

export async function runVisualRetrieval(
  projectDir: string,
  queries: VisualRetrievalQuery[],
  opts: VisualRetrievalOptions = {},
): Promise<VisualRetrievalEvidence[]> {
  if (queries.length === 0) return [];

  const limit = opts.limitPerQuery ?? DEFAULT_LIMIT_PER_QUERY;
  const maxTotalResults = opts.maxTotalResults ?? DEFAULT_MAX_TOTAL_RESULTS;
  const evidence: VisualRetrievalEvidence[] = [];

  for (const query of queries) {
    const searchInput = {
      query: query.query,
      semantic: query.query,
      mode: "hybrid" as const,
      limit,
    };
    try {
      const response = await searchFootage(projectDir, searchInput);
      const warnings = [...response.warnings];
      let results: VisualRetrievalResult[] = [];
      if (response.db_status === "fallback" || response.db_status === "missing" || response.db_status === "malformed") {
        warnings.push(`visual retrieval skipped non-Qwen search response: db_status=${response.db_status}`);
      } else {
        results = dedupeWithinQuery(response.results.flatMap((result) => {
          const visualResult = toVisualResult(result);
          return visualResult ? [visualResult] : [];
        }), resultFinalScore);
        if (response.results.length > 0 && results.length === 0) {
          warnings.push("visual retrieval skipped results without qwen_visual scores");
        }
      }
      evidence.push({
        query_id: query.query_id,
        source: query.source,
        query: query.query,
        search_input: searchInput,
        mode: "hybrid",
        results,
        warnings: Array.from(new Set(warnings)),
      });
    } catch (error) {
      evidence.push({
        query_id: query.query_id,
        source: query.source,
        query: query.query,
        search_input: searchInput,
        mode: "hybrid",
        results: [],
        warnings: [
          `visual retrieval failed for ${query.query_id}: ${error instanceof Error ? error.message : String(error)}`,
        ],
      });
    }
  }

  return dedupeAcrossQueries(evidence, maxTotalResults, resultFinalScore);
}

export async function runAudioRetrieval(
  projectDir: string,
  queries: AudioRetrievalQuery[],
  opts: AudioRetrievalOptions = {},
): Promise<AudioRetrievalEvidence[]> {
  if (queries.length === 0) return [];

  const limit = opts.limitPerQuery ?? DEFAULT_LIMIT_PER_QUERY;
  const maxTotalResults = opts.maxTotalResults ?? DEFAULT_MAX_TOTAL_RESULTS;
  const evidence: AudioRetrievalEvidence[] = [];

  for (const query of queries) {
    const searchInput = {
      query: query.query,
      semantic: query.query,
      mode: "hybrid" as const,
      limit,
    };
    try {
      const response = await searchFootage(projectDir, searchInput);
      const warnings = [...response.warnings];
      let results: AudioRetrievalResult[] = [];
      if (response.db_status === "fallback" || response.db_status === "missing" || response.db_status === "malformed") {
        warnings.push(`audio retrieval skipped non-CLAP search response: db_status=${response.db_status}`);
      } else {
        results = dedupeWithinQuery(response.results.flatMap((result) => {
          const audioResult = toAudioResult(result);
          return audioResult ? [audioResult] : [];
        }), resultAudioRankScore);
        if (response.results.length > 0 && results.length === 0) {
          warnings.push("audio retrieval skipped results without audio_similarity scores");
        }
      }
      evidence.push({
        query_id: query.query_id,
        source: query.source,
        query: query.query,
        channel: "audio",
        search_input: searchInput,
        mode: "hybrid",
        results,
        warnings: Array.from(new Set(warnings)),
      });
    } catch (error) {
      evidence.push({
        query_id: query.query_id,
        source: query.source,
        query: query.query,
        channel: "audio",
        search_input: searchInput,
        mode: "hybrid",
        results: [],
        warnings: [
          `audio retrieval failed for ${query.query_id}: ${error instanceof Error ? error.message : String(error)}`,
        ],
      });
    }
  }

  return dedupeAcrossQueries(evidence, maxTotalResults, resultAudioRankScore);
}

function truncateText(value: string, maxChars: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, maxChars - 3).trimEnd()}...`;
}

function roundScore(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  return Math.round(value * 1000) / 1000;
}

export function formatEvidenceForPrompt(evidence: VisualRetrievalEvidence[]): string {
  const entries = evidence.filter((entry) => entry.results.length > 0);
  if (entries.length === 0) return "";

  const payload = {
    visual_retrieval_evidence: entries.map((entry) => ({
      query_id: entry.query_id,
      query: truncateText(entry.query, PROMPT_QUERY_MAX_CHARS),
      results: entry.results.map((result) => ({
        segment_id: result.segment_id,
        asset_id: result.asset_id,
        src_in_us: result.src_in_us,
        src_out_us: result.src_out_us,
        summary: truncateText(result.summary, PROMPT_SUMMARY_MAX_CHARS),
        scores: {
          qwen_visual: roundScore(result.score_breakdown.qwen_visual),
          qwen_text: roundScore(result.score_breakdown.qwen_text),
          e5_text: roundScore(result.score_breakdown.e5_text),
          final: roundScore(result.score_breakdown.final),
        },
        ...(result.matched_frame_path ? { matched_frame_path: result.matched_frame_path } : {}),
        ...(result.matched_embedding_type ? { matched_embedding_type: result.matched_embedding_type } : {}),
      })),
      warnings: entry.warnings,
    })),
  };

  const lines = [
    "## Visual Retrieval Evidence (Qwen3-VL)",
    "",
    "The following segments scored highest on visual similarity for the brief's visual priorities.",
    "Treat this as ranked evidence, not mandatory selection. Prefer candidates that satisfy both brief intent and strong Qwen visual evidence. When selecting a retrieved segment, cite the query_id and qwen_visual score in candidate evidence.",
    "",
    "```json",
    JSON.stringify(payload, null, 2),
    "```",
  ];

  return lines.join("\n").trimEnd();
}

export function formatAudioEvidenceForPrompt(evidence: AudioRetrievalEvidence[]): string {
  const entries = evidence.filter((entry) => entry.results.length > 0);
  if (entries.length === 0) return "";

  const payload = {
    audio_retrieval_evidence: entries.map((entry) => ({
      query_id: entry.query_id,
      query: truncateText(entry.query, PROMPT_QUERY_MAX_CHARS),
      results: entry.results.map((result) => ({
        segment_id: result.segment_id,
        asset_id: result.asset_id,
        src_in_us: result.src_in_us,
        src_out_us: result.src_out_us,
        summary: truncateText(result.summary, PROMPT_SUMMARY_MAX_CHARS),
        scores: {
          audio_similarity: roundScore(result.score_breakdown.audio_similarity),
          qwen_text: roundScore(result.score_breakdown.qwen_text),
          e5_text: roundScore(result.score_breakdown.e5_text),
          final: roundScore(result.score_breakdown.final),
        },
        ...(result.matched_audio_ref ? { matched_audio_ref: result.matched_audio_ref } : {}),
        ...(result.matched_embedding_type ? { matched_embedding_type: result.matched_embedding_type } : {}),
      })),
      warnings: entry.warnings,
    })),
  };

  const lines = [
    "## Audio Retrieval Evidence (CLAP)",
    "",
    "The following segments scored highest on CLAP audio similarity for the brief's audio priorities.",
    "Treat this as ranked acoustic evidence, not mandatory selection. Prefer candidates that satisfy both brief intent and usable source audio. When selecting a retrieved segment, cite the query_id and audio_similarity score in candidate evidence.",
    "",
    "```json",
    JSON.stringify(payload, null, 2),
    "```",
  ];

  return lines.join("\n").trimEnd();
}

function traceSearchInput(entry: RetrievalEvidence): RetrievalSearchInput {
  return entry.search_input ?? {
    query: entry.query,
    semantic: entry.query,
    mode: "hybrid",
    limit: entry.results.length,
  };
}

function traceChannel(entry: RetrievalEvidence): RetrievalChannel {
  return entry.channel ?? "visual";
}

export function buildVisualRetrievalTrace(
  projectId: string,
  evidence: RetrievalEvidence[],
  now: string,
  selectedLinkage?: VisualRetrievalSelectedLinkage[],
): VisualRetrievalTrace {
  const segmentIds = new Set<string>();
  const warnings = new Set<string>();
  for (const entry of evidence) {
    for (const result of entry.results) segmentIds.add(result.segment_id);
    for (const warning of entry.warnings) warnings.add(warning);
  }
  if (evidence.length === 0) {
    warnings.add("no visual retrieval queries or results were generated");
  }
  const trace: VisualRetrievalTrace = {
    project_id: projectId,
    timestamp: now,
    queries: evidence.map((entry) => ({
      query_id: entry.query_id,
      source: entry.source,
      channel: traceChannel(entry),
      query: entry.query,
      search_input: traceSearchInput(entry),
      result_count: entry.results.length,
      results: entry.results,
      warnings: entry.warnings,
    })),
    total_unique_segments: segmentIds.size,
    warnings: [...warnings],
  };
  if (selectedLinkage && selectedLinkage.length > 0) {
    trace.selected_linkage = selectedLinkage;
  }
  return trace;
}

export function buildSelectedLinkage(
  selects: SelectsCandidates,
  evidence: VisualRetrievalEvidence[],
): VisualRetrievalSelectedLinkage[] {
  const selectedSegmentIds = new Set(selects.candidates.map((candidate) => candidate.segment_id));
  const bySegment = new Map<string, {
    queryIds: Set<string>;
    bestQwenVisual: number;
    bestFinal: number;
  }>();

  for (const entry of evidence) {
    for (const result of entry.results) {
      if (!selectedSegmentIds.has(result.segment_id)) continue;
      const qwenVisual = result.score_breakdown.qwen_visual;
      if (qwenVisual === undefined) continue;
      const current = bySegment.get(result.segment_id) ?? {
        queryIds: new Set<string>(),
        bestQwenVisual: Number.NEGATIVE_INFINITY,
        bestFinal: Number.NEGATIVE_INFINITY,
      };
      current.queryIds.add(entry.query_id);
      current.bestQwenVisual = Math.max(current.bestQwenVisual, qwenVisual);
      current.bestFinal = Math.max(current.bestFinal, result.score_breakdown.final);
      bySegment.set(result.segment_id, current);
    }
  }

  return [...bySegment.entries()]
    .map(([segmentId, linkage]) => ({
      segment_id: segmentId,
      query_ids: [...linkage.queryIds].sort((a, b) => a.localeCompare(b)),
      best_qwen_visual: roundScore(linkage.bestQwenVisual) ?? linkage.bestQwenVisual,
      best_final: roundScore(linkage.bestFinal) ?? linkage.bestFinal,
    }))
    .sort((a, b) => b.best_final - a.best_final || a.segment_id.localeCompare(b.segment_id));
}
