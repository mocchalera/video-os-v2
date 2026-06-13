// LLM judge — optional rubric scoring of a candidate cut against the
// golden cut, using Gemini (same API pattern as connectors/gemini-vlm).
//
// The deterministic agreement metrics measure WHAT diverged; the judge
// estimates whether the divergence helps or hurts the edit. Skipped
// gracefully (returns null) when GEMINI_API_KEY is absent.

import type { CreativeBrief, TimelineIR } from "../artifacts/types.js";
import { clamp01 } from "./matching.js";
import type { LlmJudgeReport, LlmJudgeScores } from "./types.js";

// Judge calls are rare (one per eval) but need editorial judgment, so the
// mid-tier flash is worth it; override with EVAL_JUDGE_MODEL if needed.
// (gemini-2.0-flash was sunset — 404 as of 2026-06.)
const DEFAULT_JUDGE_MODEL = "gemini-2.5-flash";

interface JudgeInput {
  brief: CreativeBrief | null;
  golden: TimelineIR;
  candidate: TimelineIR;
}

function describeTimeline(timeline: TimelineIR): string {
  const fps = timeline.sequence.fps_num / (timeline.sequence.fps_den || 1);
  const videoTracks = timeline.tracks.video ?? [];
  const lines: string[] = [];
  // Group by track and sort within a track by start time. Without this the
  // judge sees V1 then V2 clips interleaved out of order and misreads an
  // overlay layer (V2 B-roll over V1) as multiple clips "at the same start
  // time" — i.e. an unplayable cut — when it is a normal multi-track edit.
  if (videoTracks.length > 1) {
    lines.push(
      `(Multi-track edit: V1 is the base cut; V2+ are overlay/B-roll layered ON TOP of V1, played simultaneously — not a sequential-playback error.)`,
    );
  }
  for (const track of videoTracks) {
    lines.push(`Video track ${track.track_id} (${track.clips.length} clips):`);
    const clips = [...track.clips].sort(
      (a, b) => a.timeline_in_frame - b.timeline_in_frame,
    );
    for (const clip of clips) {
      const start = (clip.timeline_in_frame / fps).toFixed(1);
      const dur = (clip.timeline_duration_frames / fps).toFixed(1);
      lines.push(
        `  [${track.track_id} ${clip.beat_id}] ${start}s +${dur}s role=${clip.role} segment=${clip.segment_id} motivation="${clip.motivation}"`,
      );
    }
  }
  return lines.join("\n");
}

export function buildJudgePrompt(input: JudgeInput): string {
  const briefSection = input.brief
    ? [
        `Title: ${input.brief.project.title}`,
        `Strategy: ${input.brief.project.strategy}`,
        `Primary message: ${input.brief.message.primary}`,
        `Emotion curve: ${input.brief.emotion_curve.join(" → ")}`,
      ].join("\n")
    : "(brief unavailable)";

  return [
    "You are a senior film editor judging a rough cut produced by an AI assistant.",
    "A human editor previously approved the GOLDEN cut for this project.",
    "Judge how well the CANDIDATE cut serves the creative brief, using the golden cut as the reference for editorial taste.",
    "",
    "## Creative brief",
    briefSection,
    "",
    "## GOLDEN cut (human-approved reference)",
    describeTimeline(input.golden),
    "",
    "## CANDIDATE cut (under evaluation)",
    describeTimeline(input.candidate),
    "",
    "## Scoring rubric (0-10 each, integers)",
    "Multiple video tracks (V1, V2, ...) are layered, not sequential: V2+ clips play ON TOP of V1 as overlay/B-roll. Do NOT treat overlapping start times across tracks as a playback error.",
    "- emotion: does the candidate preserve the emotional arc the brief asks for?",
    "- story: does the clip order tell the intended story (setup → experience → payoff)?",
    "- rhythm: is the pacing of cut lengths appropriate for the cadence and channel?",
    "- agreement_with_golden: how close are the candidate's editorial choices (selection, order, emphasis) to the golden cut? Divergence that clearly improves the edit should NOT be punished here beyond 7.",
    "",
    'Respond with JSON only: {"emotion": n, "story": n, "rhythm": n, "agreement_with_golden": n, "rationale": "2-4 sentences"}',
  ].join("\n");
}

/** Parse RetryInfo.retryDelay ("46s") out of a 429 body; null if absent. */
export function parseRetryDelayMs(body: string): number | null {
  const match = body.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/);
  if (!match) return null;
  return Math.ceil(Number(match[1]) * 1000);
}

const MAX_RETRIES = 2;
const MAX_RETRY_DELAY_MS = 70_000;

async function callGeminiJson(prompt: string, model: string): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY environment variable is required");
  }
  // Key goes in a header (not the URL) so it cannot leak via logged URLs.
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          // 2.5-era flash models spend output tokens on thinking before the
          // JSON; a small cap truncates the response mid-string.
          maxOutputTokens: 8192,
          temperature: 0.1,
          responseMimeType: "application/json",
        },
      }),
    });
    if (response.ok) {
      const data = (await response.json()) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      };
      return data.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";
    }

    const body = await response.text();
    // Free-tier per-minute quotas return 429 with a RetryInfo hint.
    if (response.status === 429 && attempt < MAX_RETRIES) {
      const delayMs = Math.min(
        parseRetryDelayMs(body) ?? 30_000,
        MAX_RETRY_DELAY_MS,
      );
      console.error(
        `  llm-judge: rate limited (429), retrying in ${Math.round(delayMs / 1000)}s (attempt ${attempt + 1}/${MAX_RETRIES})`,
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      continue;
    }
    throw new Error(`Gemini API error ${response.status}: ${body}`);
  }
}

function toScore(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(10, Math.max(0, n));
}

export function parseJudgeResponse(rawJson: string, model: string): LlmJudgeReport {
  const parsed = JSON.parse(rawJson) as Record<string, unknown>;
  const scores: LlmJudgeScores = {
    emotion: toScore(parsed.emotion),
    story: toScore(parsed.story),
    rhythm: toScore(parsed.rhythm),
    agreement_with_golden: toScore(parsed.agreement_with_golden),
  };
  const composite =
    (scores.emotion + scores.story + scores.rhythm + scores.agreement_with_golden) / 40;
  return {
    model,
    scores,
    score: clamp01(composite),
    rationale: typeof parsed.rationale === "string" ? parsed.rationale : "",
  };
}

export function judgeAvailable(): boolean {
  return Boolean(process.env.GEMINI_API_KEY);
}

/**
 * Run the LLM judge. Returns null (without throwing) when no API key
 * is configured, so deterministic evals never depend on network access.
 */
export async function runLlmJudge(input: JudgeInput): Promise<LlmJudgeReport | null> {
  if (!judgeAvailable()) return null;
  const model = process.env.EVAL_JUDGE_MODEL || DEFAULT_JUDGE_MODEL;
  const rawJson = await callGeminiJson(buildJudgePrompt(input), model);
  return parseJudgeResponse(rawJson, model);
}
