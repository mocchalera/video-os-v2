import { stringify as stringifyYaml } from "yaml";
import type { CreativeBrief } from "../artifacts/types.js";
import { callGeminiJson } from "../connectors/gemini-json.js";
import { clamp01 } from "./matching.js";
import {
  BRIEF_ALIGNMENT_AXES,
  type AxisScore,
  type BriefAlignmentAxis,
} from "./brief-alignment-types.js";

export const DEFAULT_BRIEF_ALIGNMENT_JUDGE_MODEL = "gemini-2.5-flash-lite";

export interface BriefAlignmentJudgeInput {
  brief: CreativeBrief;
  stage: "selects" | "blueprint";
  artifactYaml: string;
}

export interface RunBriefAlignmentJudgeOptions {
  apiKey?: string | null;
  model?: string;
  callJson?: (prompt: string, model: string) => Promise<string>;
}

function compactBrief(brief: CreativeBrief): Record<string, unknown> {
  return {
    title: brief.project?.title,
    strategy: brief.project?.strategy,
    runtime_target_sec: brief.project?.runtime_target_sec,
    duration_mode: brief.project?.duration_mode,
    primary_message: brief.message?.primary,
    secondary_messages: brief.message?.secondary ?? [],
    emotion_curve: brief.emotion_curve ?? [],
    order_policy: brief.order_policy,
    caption_policy: brief.caption_policy,
    audio_policy: brief.audio_policy,
    must_have: (brief as { must_have?: unknown }).must_have ?? [],
    must_avoid: (brief as { must_avoid?: unknown }).must_avoid ?? [],
    hypotheses: (brief as { hypotheses?: unknown }).hypotheses ?? undefined,
    forbidden_interpretations:
      (brief as { forbidden_interpretations?: unknown }).forbidden_interpretations ?? undefined,
    editorial: brief.editorial ?? undefined,
  };
}

export function buildBriefAlignmentJudgePrompt(input: BriefAlignmentJudgeInput): string {
  return [
    "You are a senior film editor evaluating whether an AI-generated planning artifact serves a creative brief.",
    "Score the artifact itself. Do not compare against any human golden answer.",
    "Use this rubric: 1.0=fully aligned, 0.8=strong, 0.6=usable rough cut, 0.4=structurally present but weak, 0.2=mostly off-brief, 0.0=unusable.",
    "Every score must be a number from 0 to 1. Confidence must be 0 to 1. Evidence and gaps must be short strings grounded in the artifact.",
    "",
    "Axes:",
    "- intent_message_alignment: selected/planned moments express the primary message and avoid forbidden interpretations.",
    "- must_have_coverage: must_have requirements are represented or appropriately deferred as production policy.",
    "- emotion_curve_alignment: opening, development, peak/release, and ending follow the requested emotion curve.",
    "- narrative_structure: hook/setup/experience/payoff/closing are legible and ordered.",
    "- pacing_coherence: rhythm, duration, audio/caption policies, and cut density fit the brief.",
    "- visual_variety_and_focus: visual/role/cluster variety supports the theme without becoming unfocused.",
    "",
    "## Creative brief",
    stringifyYaml(compactBrief(input.brief)).trim(),
    "",
    `## ${input.stage} artifact YAML`,
    input.artifactYaml.trim(),
    "",
    "Respond with JSON only. Shape:",
    '{"axes":{"intent_message_alignment":{"score":0.8,"confidence":0.7,"evidence":["..."],"gaps":["..."]},"must_have_coverage":{"score":0.8,"confidence":0.7,"evidence":["..."],"gaps":["..."]},"emotion_curve_alignment":{"score":0.8,"confidence":0.7,"evidence":["..."],"gaps":["..."]},"narrative_structure":{"score":0.8,"confidence":0.7,"evidence":["..."],"gaps":["..."]},"pacing_coherence":{"score":0.8,"confidence":0.7,"evidence":["..."],"gaps":["..."]},"visual_variety_and_focus":{"score":0.8,"confidence":0.7,"evidence":["..."],"gaps":["..."]}},"notes":["..."]}',
  ].join("\n");
}

function toNumber(value: unknown, fallback = 0): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item)).filter((item) => item.trim().length > 0);
}

function parseAxis(value: unknown): AxisScore {
  const raw = (value ?? {}) as Record<string, unknown>;
  return {
    score: Math.round(clamp01(toNumber(raw.score)) * 1000) / 1000,
    confidence: Math.round(clamp01(toNumber(raw.confidence, 0.5)) * 1000) / 1000,
    judge_source: "llm_artifact",
    evidence: toStringArray(raw.evidence),
    gaps: toStringArray(raw.gaps),
  };
}

export interface BriefAlignmentJudgeReport {
  model: string;
  axes: Record<BriefAlignmentAxis, AxisScore>;
  notes: string[];
}

export function parseBriefAlignmentJudgeResponse(
  rawJson: string,
  model: string,
): BriefAlignmentJudgeReport {
  const parsed = JSON.parse(rawJson) as Record<string, unknown>;
  const rawAxes = (parsed.axes ?? {}) as Record<string, unknown>;
  const axes = Object.fromEntries(
    BRIEF_ALIGNMENT_AXES.map((axisName) => [axisName, parseAxis(rawAxes[axisName])]),
  ) as Record<BriefAlignmentAxis, AxisScore>;
  return {
    model,
    axes,
    notes: toStringArray(parsed.notes),
  };
}

export function briefAlignmentJudgeAvailable(apiKey = process.env.GEMINI_API_KEY): boolean {
  return Boolean(apiKey);
}

export async function runBriefAlignmentJudge(
  input: BriefAlignmentJudgeInput,
  options: RunBriefAlignmentJudgeOptions = {},
): Promise<BriefAlignmentJudgeReport | null> {
  if (!briefAlignmentJudgeAvailable(options.apiKey ?? process.env.GEMINI_API_KEY)) return null;
  const model =
    options.model ?? process.env.BRIEF_ALIGNMENT_JUDGE_MODEL ?? DEFAULT_BRIEF_ALIGNMENT_JUDGE_MODEL;
  const caller =
    options.callJson ??
    ((prompt: string, modelName: string) =>
      callGeminiJson(prompt, modelName, {
        retryLabel: `brief-alignment-${input.stage}`,
        maxOutputTokens: 8192,
      }));
  const rawJson = await caller(buildBriefAlignmentJudgePrompt(input), model);
  return parseBriefAlignmentJudgeResponse(rawJson, model);
}
