/** Shared Gemini JSON connector. */

import * as fs from "node:fs";

export interface GeminiJsonOptions {
  maxOutputTokens?: number;
  temperature?: number;
  retryLabel?: string;
  /** Remaining stage budget for one bounded provider call path. */
  timeoutMs?: number;
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

class GeminiRequestTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Gemini request timed out after ${timeoutMs}ms`);
    this.name = "TimeoutError";
  }
}

function positiveTimeoutMs(options: GeminiJsonOptions): number | undefined {
  const timeoutMs = options.timeoutMs;
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return undefined;
  }
  return Math.max(1, Math.trunc(timeoutMs));
}

/**
 * Keep the complete Gemini attempt path inside the caller's deadline. This
 * covers response-body reads as well as fetch itself, and rejects even a test
 * or custom fetch implementation that ignores AbortSignal.
 */
async function withGeminiDeadline<T>(
  deadlineAtMs: number | undefined,
  timeoutMs: number | undefined,
  operation: (signal?: AbortSignal) => Promise<T>,
): Promise<T> {
  if (deadlineAtMs === undefined) return operation();
  const remainingMs = deadlineAtMs - Date.now();
  if (remainingMs <= 0) throw new GeminiRequestTimeoutError(timeoutMs ?? 1);

  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new GeminiRequestTimeoutError(timeoutMs ?? Math.max(1, remainingMs)));
    }, remainingMs);
  });
  try {
    return await Promise.race([operation(controller.signal), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitForRetry(
  delayMs: number,
  deadlineAtMs: number | undefined,
  timeoutMs: number | undefined,
): Promise<void> {
  if (deadlineAtMs === undefined) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return;
  }
  const remainingMs = deadlineAtMs - Date.now();
  if (remainingMs <= 0) throw new GeminiRequestTimeoutError(timeoutMs ?? 1);
  await new Promise((resolve) => setTimeout(resolve, Math.min(delayMs, remainingMs)));
  if (Date.now() >= deadlineAtMs) throw new GeminiRequestTimeoutError(timeoutMs ?? 1);
}

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
  inheritedDeadlineAtMs?: number,
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
  const timeoutMs = positiveTimeoutMs(options);
  const deadlineAtMs = inheritedDeadlineAtMs
    ?? (timeoutMs === undefined ? undefined : Date.now() + timeoutMs);

  for (let attempt = 0; ; attempt += 1) {
    const { response, body } = await withGeminiDeadline(
      deadlineAtMs,
      timeoutMs,
      async (signal) => {
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
          ...(signal ? { signal } : {}),
        });
        return { response, body: await response.text() };
      },
    );
    if (response.ok) {
      const data = JSON.parse(body) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>;
        promptFeedback?: { blockReason?: string; safetyRatings?: unknown[] };
      };
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      const blockReason = data.promptFeedback?.blockReason;
      if (!text && blockReason && images.length > 0) {
        console.error(`[gemini] content blocked (${blockReason}) with ${images.length} images — retrying text-only`);
        return callGeminiGenerateContent(prompt, model, options, [], deadlineAtMs);
      }
      if (!text) {
        const finishReason = data.candidates?.[0]?.finishReason;
        if (finishReason || blockReason) {
          console.error(`[gemini] empty response: finishReason=${finishReason} blockReason=${blockReason}`);
        }
      }
      return text ?? "{}";
    }

    if ((response.status === 429 || response.status === 503) && attempt < MAX_RETRIES) {
      const delayMs = Math.min(
        parseRetryDelayMs(body) ?? 30_000,
        MAX_RETRY_DELAY_MS,
      );
      console.error(
        `  ${retryLabel}: rate limited (429), retrying in ${Math.round(delayMs / 1000)}s (attempt ${attempt + 1}/${MAX_RETRIES})`,
      );
      await waitForRetry(delayMs, deadlineAtMs, timeoutMs);
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

export interface GeminiImageOutput {
  data: string;
  mimeType: string;
}

/**
 * Image-to-image edit call: sends the prompt plus one source image and returns
 * the regenerated inline image. Used by the image QC repair loop; not for
 * text-only requests.
 */
export async function callGeminiImageEdit(
  prompt: string,
  image: GeminiMultimodalImageInput,
  model: string,
  options: GeminiJsonOptions = {},
): Promise<GeminiImageOutput> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY environment variable is required");
  }
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({
      contents: [{ parts: buildParts(prompt, [image]) }],
      generationConfig: {
        responseModalities: ["IMAGE"],
      },
    }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Gemini API error ${response.status}: ${body}`);
  }
  const data = (await response.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ inline_data?: { data?: string; mime_type?: string } }> } }>;
  };
  const inline = data.candidates?.[0]?.content?.parts
    ?.map((part) => part.inline_data)
    .find((inlineData): inlineData is { data: string; mime_type: string } =>
      Boolean(inlineData?.data));
  if (!inline?.data) {
    throw new Error("Gemini image edit returned no image data");
  }
  return { data: inline.data, mimeType: inline.mime_type ?? "image/png" };
}


/**
 * Lower transport seam: POST the EXACT request body bytes supplied by the
 * caller and return the EXACT raw response body text. The image QC connector
 * builds its request body once, binds its digest into the attempt receipt,
 * and sends these exact bytes — no logical summary is signed.
 */
export async function callGeminiRawBody(model: string, body: string): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY environment variable is required");
  }
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body,
  });
  const rawText = await response.text();
  if (!response.ok) {
    throw new Error(`Gemini API error ${response.status}: ${rawText}`);
  }
  return rawText;
}

/** Parse a raw generateContent response body into the model's text output. */
export function extractTextFromRawBody(rawBody: string): string {
  const data = JSON.parse(rawBody) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const parts = data.candidates?.[0]?.content?.parts ?? [];
  const text = parts.map((part) => part.text ?? "").join("");
  if (!text) {
    throw new Error("Gemini API response contained no text");
  }
  return text;
}

/** Parse a raw generateContent image-edit response into inline image bytes. */
export function extractImageFromRawBody(rawBody: string): { data: string; mimeType: string } {
  const parsed = JSON.parse(rawBody) as {
    candidates?: Array<{ content?: { parts?: Array<{ inline_data?: { data?: string; mime_type?: string } }> } }>;
  };
  const inline = parsed.candidates?.[0]?.content?.parts
    ?.map((part) => part.inline_data)
    .find((inlineData): inlineData is { data: string; mime_type: string } => Boolean(inlineData?.data));
  if (!inline?.data) {
    throw new Error("Gemini image edit response contained no image data");
  }
  return { data: inline.data, mimeType: inline.mime_type ?? "image/png" };
}
