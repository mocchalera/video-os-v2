export const AI_JOB_PHASES = ["compile", "review", "render", "caption-finalize"] as const;
export type JobPhase = typeof AI_JOB_PHASES[number];

export type AiJobOptionSanitization =
  | { ok: true; options: Record<string, unknown> }
  | { ok: false; error: string };

const OPTION_CONTRACTS: Record<JobPhase, Record<string, "boolean" | "number" | "string">> = {
  compile: { created_at: "string", fps_num: "number" },
  review: {
    require_compiled_timeline: "boolean",
    skip_preview: "boolean",
    render: "boolean",
    allow_unverified_visual: "boolean",
    visual_qa_waiver_reason: "string",
  },
  render: {
    skip_render: "boolean",
    assembly_path: "string",
    supplied_final_path: "string",
  },
  "caption-finalize": {
    approval_path: "string",
    supplied_final_path: "string",
    supplied_final_receipt_path: "string",
    assembly_path: "string",
    skip_render: "boolean",
    created_at: "string",
  },
};

/** Keep only phase-owned options and reject malformed known values. */
export function sanitizeAiJobOptions(phase: JobPhase, input: unknown): AiJobOptionSanitization {
  if (input === undefined) return { ok: true, options: {} };
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "options must be an object" };
  }
  const source = input as Record<string, unknown>;
  const sanitized: Record<string, unknown> = {};
  for (const [key, expectedType] of Object.entries(OPTION_CONTRACTS[phase])) {
    const value = source[key];
    if (value === undefined) continue;
    if (typeof value !== expectedType) {
      return { ok: false, error: `options.${key} must be ${expectedType}` };
    }
    if (typeof value === "string" && (value.trim().length === 0 || value.length > 8_192 || value.includes("\0"))) {
      return { ok: false, error: `options.${key} must be a non-empty safe string` };
    }
    if (key === "created_at" && !Number.isFinite(Date.parse(value as string))) {
      return { ok: false, error: "options.created_at must be an ISO date-time" };
    }
    if (key === "fps_num" && (!((value as number) > 0) || !Number.isFinite(value as number))) {
      return { ok: false, error: "options.fps_num must be a positive finite number" };
    }
    sanitized[key] = value;
  }
  return { ok: true, options: sanitized };
}
