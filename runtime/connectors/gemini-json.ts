/** Shared Gemini JSON text connector. */

export interface GeminiJsonOptions {
  maxOutputTokens?: number;
  temperature?: number;
  retryLabel?: string;
}

/** Parse RetryInfo.retryDelay ("46s") out of a 429 body; null if absent. */
export function parseRetryDelayMs(body: string): number | null {
  const match = body.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/);
  if (!match) return null;
  return Math.ceil(Number(match[1]) * 1000);
}

const MAX_RETRIES = 2;
const MAX_RETRY_DELAY_MS = 70_000;

export async function callGeminiJson(
  prompt: string,
  model: string,
  options: GeminiJsonOptions = {},
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
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          maxOutputTokens,
          temperature,
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
        `  ${retryLabel}: rate limited (429), retrying in ${Math.round(delayMs / 1000)}s (attempt ${attempt + 1}/${MAX_RETRIES})`,
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      continue;
    }
    throw new Error(`Gemini API error ${response.status}: ${body}`);
  }
}
