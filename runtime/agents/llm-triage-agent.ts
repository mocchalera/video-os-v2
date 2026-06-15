import * as fs from "node:fs";
import * as path from "node:path";
import { classifyTranscriptQuality } from "../analysis/transcript-quality.js";
import { loadCreativeBrief } from "../artifacts/loaders.js";
import type { CreativeBrief, EditorialSummary } from "../artifacts/types.js";
import { callGeminiJson } from "../connectors/gemini-json.js";
import { parseLlmResponse } from "./llm-json.js";
import type {
  SelectCandidate,
  SelectsCandidates,
  TriageAgent,
  TriageAgentContext,
  TriageCoverageFeedback,
} from "../commands/triage.js";

export type LlmCompleter = (prompt: string) => Promise<string>;
export { extractJsonObject } from "./llm-json.js";

export const DEFAULT_TRIAGE_MODEL = "gemini-2.5-flash";
export const UNRELIABLE_TRANSCRIPT_TEXT = "[unreliable — judge on visuals]";

const BRIEF_REL = "01_intent/creative_brief.yaml";
const SEGMENTS_REL = "03_analysis/segments.json";

const VALID_ROLES = new Set<SelectCandidate["role"]>([
  "hero",
  "support",
  "transition",
  "texture",
  "dialogue",
  "reject",
]);

const EDITORIAL_SUMMARY_VALUES = {
  dominant_visual_mode: new Set(["talking_head", "screen_demo", "event_broll", "mixed", "unknown"]),
  speaker_topology: new Set(["solo_primary", "interviewer_guest", "multi_speaker", "unknown"]),
  motion_profile: new Set(["low", "medium", "high", "unknown"]),
  transcript_density: new Set(["sparse", "medium", "dense", "unknown"]),
} as const;

export interface CompactPeakEvidence {
  has_peak: boolean;
  types: string[];
  count: number;
}

export interface CompactSegmentEvidence {
  segment_id: string;
  asset_id: string;
  src_in_us: number;
  src_out_us: number;
  summary: string;
  tags: string[];
  peak: CompactPeakEvidence;
  transcript: string;
}

interface TriagePromptInput {
  brief: CreativeBrief;
  segments: CompactSegmentEvidence[];
  coverageFeedback?: TriageCoverageFeedback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

function integerValue(value: unknown): number | undefined {
  const n = numberValue(value);
  if (n === undefined) return undefined;
  return Math.trunc(n);
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item.length > 0);
}

function clamp01(value: unknown, fallback: number): number {
  const n = numberValue(value);
  if (n === undefined) return fallback;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function normalizeTranscript(raw: unknown): string {
  const transcript = typeof raw === "string" ? raw : "";
  const quality = classifyTranscriptQuality(transcript);
  return quality.quality === "ok" ? quality.usableText : UNRELIABLE_TRANSCRIPT_TEXT;
}

function extractPeakEvidence(segment: Record<string, unknown>): CompactPeakEvidence {
  const peakAnalysis = isRecord(segment.peak_analysis) ? segment.peak_analysis : {};
  const moments = Array.isArray(peakAnalysis.peak_moments) ? peakAnalysis.peak_moments : [];
  const types = new Set<string>();
  for (const moment of moments) {
    if (!isRecord(moment)) continue;
    const type = stringValue(moment.type) ?? stringValue(moment.peak_type);
    if (type) types.add(type);
  }
  return {
    has_peak: moments.length > 0,
    types: [...types].sort(),
    count: moments.length,
  };
}

export function compactSegmentEvidence(rawSegments: unknown[]): CompactSegmentEvidence[] {
  return rawSegments.flatMap((item): CompactSegmentEvidence[] => {
    if (!isRecord(item)) return [];
    const segmentId = stringValue(item.segment_id);
    const assetId = stringValue(item.asset_id);
    const srcInUs = integerValue(item.src_in_us);
    const srcOutUs = integerValue(item.src_out_us);
    if (!segmentId || !assetId || srcInUs === undefined || srcOutUs === undefined) return [];
    if (srcInUs < 0 || srcOutUs <= srcInUs) return [];
    return [
      {
        segment_id: segmentId,
        asset_id: assetId,
        src_in_us: srcInUs,
        src_out_us: srcOutUs,
        summary: stringValue(item.summary) ?? "",
        tags: stringArray(item.tags),
        peak: extractPeakEvidence(item),
        transcript: normalizeTranscript(item.transcript_excerpt ?? item.transcript),
      },
    ];
  });
}

export function loadCompactSegmentEvidence(projectDir: string): CompactSegmentEvidence[] {
  const segmentsPath = path.join(projectDir, SEGMENTS_REL);
  if (!fs.existsSync(segmentsPath)) {
    throw new Error(`segments.json not found: ${segmentsPath}`);
  }
  const parsed = JSON.parse(fs.readFileSync(segmentsPath, "utf-8")) as {
    items?: unknown;
    segments?: unknown;
  };
  const rawSegments = Array.isArray(parsed.items)
    ? parsed.items
    : Array.isArray(parsed.segments)
      ? parsed.segments
      : [];
  const segments = compactSegmentEvidence(rawSegments);
  if (segments.length === 0) {
    throw new Error(`segments.json has no valid segment evidence: ${segmentsPath}`);
  }
  return segments;
}

function briefMustHave(brief: CreativeBrief): string[] {
  return stringArray((brief as { must_have?: unknown }).must_have);
}

function buildCoverageFeedbackPreamble(feedback: TriageCoverageFeedback | undefined): string[] {
  if (!feedback) return [];
  return [
    `前回の選定で以下の不足が出た。必ず是正せよ: ${JSON.stringify(feedback.gaps)}。特に under-sampled な montage クラスタを増やし、sparse を解消せよ。前回選定数=${feedback.previous_selection_count}`,
    "",
  ];
}

export function buildLlmTriagePrompt(input: TriagePromptInput): string {
  const briefPayload = {
    project_id: input.brief.project_id,
    title: input.brief.project.title,
    strategy: input.brief.project.strategy,
    runtime_target_sec: input.brief.project.runtime_target_sec,
    message: {
      primary: input.brief.message.primary,
      secondary: input.brief.message.secondary ?? [],
    },
    must_have: briefMustHave(input.brief),
    emotion_curve: input.brief.emotion_curve,
  };

  return [
    ...buildCoverageFeedbackPreamble(input.coverageFeedback),
    "You are the footage-triager for Video OS. Select source segments for a rough-cut candidate board.",
    "Work from the creative brief and the segment evidence only. Prefer visual evidence over unreliable transcript text.",
    "",
    "## Creative brief",
    JSON.stringify(briefPayload, null, 2),
    "",
    "## Compact segment evidence",
    JSON.stringify(input.segments, null, 2),
    "",
    "## Selection guide",
    "- Cover every must_have item with explicit evidence.",
    "- Respect the emotion curve and source chronology unless the brief clearly asks for editorial reordering.",
    "- Include a clear opening and a clear ending.",
    "- Maintain enough breadth across assets, visual modes, and story beats for the target runtime.",
    "- Do not discard dense repetition just because shots are similar: montage clusters can be important. Sample them proportionally and avoid sparse coverage.",
    "",
    "## Output",
    "Respond with JSON only. Markdown code fences are tolerated, but do not add prose outside JSON.",
    "Use only segment_id, asset_id, src_in_us, and src_out_us values that appear in the segment evidence.",
    'Shape: {"selection_notes":["..."],"editorial_summary":{"dominant_visual_mode":"mixed","speaker_topology":"unknown","motion_profile":"medium","transcript_density":"sparse"},"candidates":[{"segment_id":"...","asset_id":"...","src_in_us":0,"src_out_us":1,"role":"hero","why_it_matches":"...","confidence":0.8,"semantic_rank":1,"evidence":["..."]}]}',
    'Valid roles: "hero", "support", "transition", "texture", "dialogue", "reject". If unsure, use "support".',
  ].join("\n");
}

export function parseLlmTriageResponse(raw: string): Record<string, unknown> {
  return parseLlmResponse(raw);
}

function normalizeRole(value: unknown): SelectCandidate["role"] | null {
  if (value === undefined || value === null || value === "") return "support";
  if (typeof value !== "string") return null;
  return VALID_ROLES.has(value as SelectCandidate["role"]) ? (value as SelectCandidate["role"]) : null;
}

function sameOptionalNumber(a: unknown, b: number): boolean {
  const n = integerValue(a);
  return n === undefined || n === b;
}

function sameOptionalString(a: unknown, b: string): boolean {
  const s = stringValue(a);
  return s === undefined || s === b;
}

function sanitizeSemanticRank(value: unknown): number | undefined {
  const n = integerValue(value);
  return n !== undefined && n >= 1 ? n : undefined;
}

function sanitizeEditorialSummary(value: unknown): EditorialSummary | undefined {
  if (!isRecord(value)) return undefined;
  const out: EditorialSummary = {};
  for (const key of Object.keys(EDITORIAL_SUMMARY_VALUES) as Array<keyof typeof EDITORIAL_SUMMARY_VALUES>) {
    const raw = stringValue(value[key]);
    if (raw && EDITORIAL_SUMMARY_VALUES[key].has(raw)) {
      (out as Record<string, string>)[key] = raw;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function selectsFromLlmResponse(
  parsed: Record<string, unknown>,
  projectId: string,
  segments: CompactSegmentEvidence[],
): SelectsCandidates {
  const segmentById = new Map(segments.map((segment) => [segment.segment_id, segment]));
  const rawCandidates = Array.isArray(parsed.candidates) ? parsed.candidates : [];
  const candidates: SelectCandidate[] = [];

  for (const item of rawCandidates) {
    if (!isRecord(item)) continue;
    const segmentId = stringValue(item.segment_id);
    if (!segmentId) continue;
    const segment = segmentById.get(segmentId);
    if (!segment) continue;
    if (!sameOptionalString(item.asset_id, segment.asset_id)) continue;
    if (!sameOptionalNumber(item.src_in_us, segment.src_in_us)) continue;
    if (!sameOptionalNumber(item.src_out_us, segment.src_out_us)) continue;

    const role = normalizeRole(item.role);
    if (!role) continue;

    const candidate: SelectCandidate = {
      segment_id: segment.segment_id,
      asset_id: segment.asset_id,
      src_in_us: segment.src_in_us,
      src_out_us: segment.src_out_us,
      role,
      why_it_matches: stringValue(item.why_it_matches) ?? segment.summary,
      risks: stringArray(item.risks),
      confidence: clamp01(item.confidence, 0.5),
    };
    const semanticRank = sanitizeSemanticRank(item.semantic_rank);
    if (semanticRank !== undefined) candidate.semantic_rank = semanticRank;
    const evidence = stringArray(item.evidence);
    if (evidence.length > 0) candidate.evidence = evidence;
    if (role === "reject") {
      candidate.rejection_reason =
        stringValue(item.rejection_reason) ?? stringValue(item.why_it_matches) ?? "LLM rejected this segment";
    }
    candidates.push(candidate);
  }

  const selects: SelectsCandidates = {
    version: "1",
    project_id: projectId,
    candidates,
  };
  const selectionNotes = stringArray(parsed.selection_notes);
  if (selectionNotes.length > 0) selects.selection_notes = selectionNotes;
  const editorialSummary = sanitizeEditorialSummary(parsed.editorial_summary);
  if (editorialSummary) selects.editorial_summary = editorialSummary;
  return selects;
}

function buildRepairPrompt(originalPrompt: string, raw: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return [
    originalPrompt,
    "",
    "The previous response was not parseable as the required JSON object.",
    `Parse error: ${message}`,
    `Previous response excerpt: ${raw.slice(0, 1200)}`,
    "JSON のみで再出力してください。説明文、前後テキスト、コードフェンスは不要です。",
  ].join("\n");
}

async function completeWithSingleJsonRetry(
  llm: LlmCompleter,
  prompt: string,
): Promise<Record<string, unknown>> {
  const first = await llm(prompt);
  try {
    return parseLlmTriageResponse(first);
  } catch (firstError) {
    const second = await llm(buildRepairPrompt(prompt, first, firstError));
    try {
      return parseLlmTriageResponse(second);
    } catch (secondError) {
      const message = secondError instanceof Error ? secondError.message : String(secondError);
      throw new Error(`LLM triage response was not valid JSON after retry: ${message}`);
    }
  }
}

export function createLlmTriageAgent(opts: { llm?: LlmCompleter; model?: string } = {}): TriageAgent {
  const model = opts.model ?? process.env.TRIAGE_MODEL ?? DEFAULT_TRIAGE_MODEL;
  // A breadth selection (20+ candidates with rationale) is a large JSON; the
  // default 8k output budget truncates it mid-object on coverage-feedback
  // rounds, so request a generous ceiling.
  const llm =
    opts.llm ?? ((prompt: string) => callGeminiJson(prompt, model, { retryLabel: "triage-llm", maxOutputTokens: 32768 }));

  return {
    async run(ctx: TriageAgentContext) {
      const brief = loadCreativeBrief(path.join(ctx.projectDir, BRIEF_REL));
      const segments = loadCompactSegmentEvidence(ctx.projectDir);
      const prompt = buildLlmTriagePrompt({
        brief,
        segments,
        coverageFeedback: ctx.coverageFeedback,
      });
      const parsed = await completeWithSingleJsonRetry(llm, prompt);
      return {
        selects: selectsFromLlmResponse(parsed, ctx.projectId, segments),
        confirmed: true,
      };
    },
  };
}
