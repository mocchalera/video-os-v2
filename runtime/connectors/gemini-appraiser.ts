/**
 * Gemini Appraiser Connector - single-frame quality/OCR/place appraisal.
 *
 * This connector intentionally does not describe the scene. Marlin owns the
 * scene/action summary; Gemini appraises one high-resolution representative
 * frame for quality, visible text, place hints, and editor-facing notes.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { callGeminiMultimodal } from "./gemini-json.js";
import type { GeminiInlineImageInput } from "./gemini-json.js";

export const DEFAULT_APPRAISER_MODEL = "gemini-2.5-flash";
export const APPRAISER_CONNECTOR_VERSION = "editorial-appraiser-v1.1.0";
export const APPRAISER_PROMPT_TEMPLATE_ID = "gemini-appraiser-v1";
export const APPRAISER_RESPONSE_FORMAT = "appraiser_json_v1";

export interface AppraiserVisualQuality {
  composition_score: number;
  light_quality: number;
  focus_sharpness: number;
  subject_prominence: number;
}

export interface AppraiserExtractedText {
  text: string;
  language: string;
  confidence: number;
}

export interface AppraiserPlaceHint {
  name: string | null;
  category: string;
  confidence: number;
  evidence: string[];
}

export interface AppraiserResult {
  visual_quality: AppraiserVisualQuality;
  extracted_text: AppraiserExtractedText[];
  place_hint: AppraiserPlaceHint;
  aesthetic_notes: string[];
}

interface RawAppraiserResponse {
  visual_quality?: unknown;
  extracted_text?: unknown;
  place_hint?: unknown;
  aesthetic_notes?: unknown;
}

export function buildAppraiserPrompt(marlinScene: string): string {
  const scene = marlinScene.trim() || "No Marlin scene context is available.";
  return `You are a visual quality appraiser. The scene has already been described by another model:
"${scene}"

Your job is to assess this frame for:
1. Visual quality: composition (0-1), lighting (0-1), focus/sharpness (0-1), subject_prominence (0-1)
2. Text/signage: extract any visible text, signs, labels, menus. Include language and confidence.
3. Place identification: if you can identify the specific place, landmark, or type of establishment, name it with confidence.
4. Aesthetic notes: 1-3 brief notes about what makes this frame visually strong or weak.

Respond with JSON only. Do not describe the scene or rewrite the segment summary.

Expected JSON shape:
{
  "visual_quality": {
    "composition_score": 0.8,
    "light_quality": 0.7,
    "focus_sharpness": 0.9,
    "subject_prominence": 0.6
  },
  "extracted_text": [
    { "text": "visible sign text", "language": "ja", "confidence": 0.95 }
  ],
  "place_hint": {
    "name": "place name or null",
    "category": "natural_landmark",
    "confidence": 0.8,
    "evidence": ["visible sign", "distinctive landmark"]
  },
  "aesthetic_notes": ["brief note"]
}`;
}

export function computeAppraiserPromptHash(schemaVersion: string = "1.0.0"): string {
  const normalized = buildAppraiserPrompt("<marlin_scene>")
    .trim()
    .replace(/\s+/g, " ");
  return createHash("sha256")
    .update(`${normalized}|${schemaVersion}`)
    .digest("hex")
    .slice(0, 16);
}

export function parseAppraiserJson(raw: string): RawAppraiserResponse {
  let cleaned = raw.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
  }

  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    throw new Error("No JSON object found in appraiser response");
  }

  cleaned = cleaned.slice(firstBrace, lastBrace + 1);
  return JSON.parse(cleaned) as RawAppraiserResponse;
}

export function normalizeAppraiserResult(raw: RawAppraiserResponse): AppraiserResult {
  return {
    visual_quality: normalizeAppraiserVisualQuality(raw.visual_quality),
    extracted_text: normalizeExtractedText(raw.extracted_text),
    place_hint: normalizePlaceHint(raw.place_hint),
    aesthetic_notes: normalizeNotes(raw.aesthetic_notes),
  };
}

export async function appraiseFrame(
  framePath: string,
  marlinScene: string,
  model: string = DEFAULT_APPRAISER_MODEL,
): Promise<AppraiserResult> {
  const image: GeminiInlineImageInput = {
    data: fs.readFileSync(framePath).toString("base64"),
    mimeType: mimeTypeForPath(framePath),
  };
  const rawJson = await callGeminiMultimodal(
    buildAppraiserPrompt(marlinScene),
    [image],
    model,
    {
      maxOutputTokens: 2048,
      temperature: 0.1,
      retryLabel: "gemini-appraiser",
    },
  );

  return normalizeAppraiserResult(parseAppraiserJson(rawJson));
}

function normalizeAppraiserVisualQuality(raw: unknown): AppraiserVisualQuality {
  const record = isRecord(raw) ? raw : {};
  const nestedScores = isRecord(record.scores) ? record.scores : {};

  return {
    composition_score: requiredScore(
      record.composition_score ?? nestedScores.composition_score,
      "visual_quality.composition_score",
    ),
    light_quality: requiredScore(
      record.light_quality ?? nestedScores.light_quality,
      "visual_quality.light_quality",
    ),
    focus_sharpness: requiredScore(
      record.focus_sharpness ??
      record.focus_score ??
      nestedScores.focus_sharpness ??
      nestedScores.focus_score,
      "visual_quality.focus_sharpness",
    ),
    subject_prominence: requiredScore(
      record.subject_prominence ?? nestedScores.subject_prominence,
      "visual_quality.subject_prominence",
    ),
  };
}

function normalizeExtractedText(raw: unknown): AppraiserExtractedText[] {
  if (!Array.isArray(raw)) return [];

  const result: AppraiserExtractedText[] = [];
  for (const item of raw) {
    if (!isRecord(item) || typeof item.text !== "string") continue;
    const text = item.text.trim();
    if (!text) continue;
    result.push({
      text,
      language: typeof item.language === "string" && item.language.trim()
        ? item.language.trim()
        : "unknown",
      confidence: clampScore(item.confidence, 0.5),
    });
    if (result.length >= 20) break;
  }
  return result;
}

function normalizePlaceHint(raw: unknown): AppraiserPlaceHint {
  const record = isRecord(raw) ? raw : {};
  const name = typeof record.name === "string" && record.name.trim()
    ? record.name.trim()
    : null;
  const category = typeof record.category === "string" && record.category.trim()
    ? toSnakeLike(record.category)
    : "unknown";

  return {
    name,
    category,
    confidence: clampScore(record.confidence, name ? 0.5 : 0),
    evidence: normalizeStringArray(record.evidence, 8),
  };
}

function normalizeNotes(raw: unknown): string[] {
  return normalizeStringArray(raw, 3);
}

function normalizeStringArray(raw: unknown, maxItems: number): string[] {
  if (!Array.isArray(raw)) return [];
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const value = item.trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value.slice(0, 240));
    if (result.length >= maxItems) break;
  }
  return result;
}

function clampScore(value: unknown, fallback = 0.5): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(1, value));
}

function requiredScore(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Missing numeric ${field}`);
  }
  return Math.max(0, Math.min(1, value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toSnakeLike(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || "unknown";
}

function mimeTypeForPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  return "image/jpeg";
}
