import type { CreativeBrief, SelectsCandidates } from "../artifacts/types.js";
import { searchFootage, type FootageSearchResult } from "../tools/footage-search.js";

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
  source: "brief.must_have" | "brief.editorial.policy_hint";
  query: string;
  search_input: {
    query: string;
    semantic: string;
    mode: "hybrid";
    limit: number;
  };
  mode: "hybrid";
  results: VisualRetrievalResult[];
  warnings: string[];
}

export interface VisualRetrievalTrace {
  project_id: string;
  timestamp: string;
  queries: Array<{
    query_id: string;
    source: VisualRetrievalEvidence["source"];
    query: string;
    search_input: VisualRetrievalEvidence["search_input"];
    result_count: number;
    results: VisualRetrievalResult[];
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
  source: VisualRetrievalEvidence["source"];
  query: string;
}

export interface VisualRetrievalOptions {
  limitPerQuery?: number;
  maxTotalResults?: number;
}

const VISUAL_PRIORITY_PREFIX = "Qwen3-VL visual search priority:";
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

function finiteScore(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function resultFinalScore(result: VisualRetrievalResult): number {
  return result.score_breakdown.final;
}

function matchedEmbeddingType(result: FootageSearchResult): string | undefined {
  const matches = result.scores.embedding_matches ?? [];
  return matches.find((match) => match.embedding_type.startsWith("visual_"))?.embedding_type
    ?? matches[0]?.embedding_type;
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

function dedupeWithinQuery(results: VisualRetrievalResult[]): VisualRetrievalResult[] {
  const bestBySegment = new Map<string, VisualRetrievalResult>();
  for (const result of results) {
    const previous = bestBySegment.get(result.segment_id);
    if (!previous || resultFinalScore(result) > resultFinalScore(previous)) {
      bestBySegment.set(result.segment_id, result);
    }
  }
  return [...bestBySegment.values()].sort((a, b) =>
    resultFinalScore(b) - resultFinalScore(a) || a.segment_id.localeCompare(b.segment_id)
  );
}

function dedupeAcrossQueries(
  evidence: VisualRetrievalEvidence[],
  maxTotalResults: number,
): VisualRetrievalEvidence[] {
  const bestBySegment = new Map<string, {
    evidenceIndex: number;
    resultIndex: number;
    result: VisualRetrievalResult;
  }>();

  evidence.forEach((entry, evidenceIndex) => {
    entry.results.forEach((result, resultIndex) => {
      const previous = bestBySegment.get(result.segment_id);
      const nextScore = resultFinalScore(result);
      const previousScore = previous ? resultFinalScore(previous.result) : -Infinity;
      if (!previous || nextScore > previousScore) {
        bestBySegment.set(result.segment_id, { evidenceIndex, resultIndex, result });
      }
    });
  });

  const kept = new Set(
    [...bestBySegment.values()]
      .sort((a, b) =>
        resultFinalScore(b.result) - resultFinalScore(a.result)
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
      .sort((a, b) => resultFinalScore(b) - resultFinalScore(a) || a.segment_id.localeCompare(b.segment_id)),
  }));
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
        }));
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

  return dedupeAcrossQueries(evidence, maxTotalResults);
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

function traceSearchInput(entry: VisualRetrievalEvidence): VisualRetrievalEvidence["search_input"] {
  return entry.search_input ?? {
    query: entry.query,
    semantic: entry.query,
    mode: "hybrid",
    limit: entry.results.length,
  };
}

export function buildVisualRetrievalTrace(
  projectId: string,
  evidence: VisualRetrievalEvidence[],
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
