function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function extractFencedJson(raw: string): string | undefined {
  const match = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return match?.[1]?.trim();
}

export function extractJsonObject(raw: string): string {
  const fenced = extractFencedJson(raw);
  if (fenced) return fenced;

  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === "\"") {
        inString = false;
      }
      continue;
    }
    if (ch === "\"") {
      inString = true;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) start = i;
      depth += 1;
      continue;
    }
    if (ch === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) return raw.slice(start, i + 1);
    }
  }
  throw new Error("No JSON object found in LLM response");
}

export function parseLlmResponse(raw: string): Record<string, unknown> {
  const parsed = JSON.parse(extractJsonObject(raw)) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("LLM response JSON must be an object");
  }
  return parsed;
}
