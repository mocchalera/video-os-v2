/** Shared Gemini JSON connector. */

import * as fs from "node:fs";

export interface GeminiJsonOptions {
  maxOutputTokens?: number;
  temperature?: number;
  retryLabel?: string;
}

export interface GeminiImagePathInput {
  path: string;
  mimeType: string;
}

export interface GeminiInlineImageInput {
  data: string;
  mimeType: string;
}

export type GeminiMultimodalImageInput = GeminiImagePathInput | GeminiInlineImageInput;

/** Parse RetryInfo.retryDelay ("46s") out of a 429 body; null if absent. */
export function parseRetryDelayMs(body: string): number | null {
  const match = body.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/);
  if (!match) return null;
  return Math.ceil(Number(match[1]) * 1000);
}

const MAX_RETRIES = 2;
const MAX_RETRY_DELAY_MS = 70_000;

function imageData(image: GeminiMultimodalImageInput): string {
  if ("data" in image) return image.data;
  return fs.readFileSync(image.path).toString("base64");
}

function buildParts(prompt: string, images: GeminiMultimodalImageInput[]): Array<Record<string, unknown>> {
  if (images.length === 0) return [{ text: prompt }];
  return [
    ...images.map((image) => ({
      inline_data: {
        mime_type: image.mimeType,
        data: imageData(image),
      },
    })),
    { text: prompt },
  ];
}

async function callGeminiGenerateContent(
  prompt: string,
  model: string,
  options: GeminiJsonOptions = {},
  images: GeminiMultimodalImageInput[] = [],
): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY environment variable is required");
  }
  // Key goes in a header (not the URL) so it cannot leak via logged URLs.
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const maxOutputTokens = options.maxOutputTokens ?? 8192;
  const temperature = options.temperature ?? 0.1;
  const retryLabel = options.retryLabel ?? "gemini-json";

  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        contents: [{ parts: buildParts(prompt, images) }],
        generationConfig: {
          maxOutputTokens,
          temperature,
          responseMimeType: "application/json",
        },
      }),
    });
    if (response.ok) {
      const data = (await response.json()) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>;
        promptFeedback?: { blockReason?: string; safetyRatings?: unknown[] };
      };
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      const blockReason = data.promptFeedback?.blockReason;
      if (!text && blockReason && images.length > 0) {
        console.error(`[gemini] content blocked (${blockReason}) with ${images.length} images — retrying text-only`);
        return callGeminiGenerateContent(prompt, model, options);
      }
      if (!text) {
        const finishReason = data.candidates?.[0]?.finishReason;
        if (finishReason || blockReason) {
          console.error(`[gemini] empty response: finishReason=${finishReason} blockReason=${blockReason}`);
        }
      }
      return text ?? "{}";
    }

    const body = await response.text();
    if ((response.status === 429 || response.status === 503) && attempt < MAX_RETRIES) {
      const delayMs = Math.min(
        parseRetryDelayMs(body) ?? 30_000,
        MAX_RETRY_DELAY_MS,
      );
      console.error(
        `  ${retryLabel}: rate limited (429), retrying in ${Math.round(delayMs / 1000)}s (attempt ${attempt + 1}/${MAX_RETRIES})`,
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      continue;
    }
    throw new Error(`Gemini API error ${response.status}: ${body}`);
  }
}

export async function callGeminiJson(
  prompt: string,
  model: string,
  options: GeminiJsonOptions = {},
): Promise<string> {
  return callGeminiGenerateContent(prompt, model, options);
}

export async function callGeminiMultimodal(
  prompt: string,
  images: GeminiMultimodalImageInput[],
  model: string,
  options: GeminiJsonOptions = {},
): Promise<string> {
  return callGeminiGenerateContent(prompt, model, options, images);
}
