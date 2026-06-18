import { callGeminiJson } from "../connectors/gemini-json.js";
import type { MarlinEventsArtifact, MarlinEvent } from "../connectors/marlin-types.js";
import type {
  Beat,
  CreativeBrief,
  EditBlueprint,
  SelectsCandidates,
} from "../artifacts/types.js";
import type { CraftDirective } from "../compiler/types.js";
import { buildCandidateIndex, type CompactBlueprintCandidate } from "./llm-blueprint-agent.js";
import { parseLlmResponse } from "./llm-json.js";
import type { LlmCompleter } from "./llm-triage-agent.js";
import type {
  CraftDecision,
  CraftIssue,
  CraftRevision,
  CraftVerdict,
} from "./editorial-craft-types.js";

// Cockpit/repo-side craft review should prefer Claude/Codex subscription agents.
// Gemini flash-lite is the headless CLI fallback.
export const DEFAULT_CRAFT_REVIEW_MODEL = "gemini-2.5-flash-lite";

export interface CraftReviewOptions {
  model?: string;
  llm?: LlmCompleter;
}

const VALID_VERDICTS = new Set<CraftVerdict>(["accept", "revise", "block"]);
const VALID_SEVERITIES = new Set<CraftIssue["severity"]>(["critical", "improvement", "taste"]);
const VALID_CRAFT_IN_POINT = new Set<NonNullable<CraftDirective["in_point"]>>([
  "cut_on_action",
  "peak_hold",
  "pre_roll_enter",
  "post_action_hold",
  "clean_in_clean_out",
]);
const VALID_CRAFT_OUT_POINT = new Set<NonNullable<CraftDirective["out_point"]>>([
  "cut_on_action",
  "peak_hold",
  "post_action_hold",
  "clean_in_clean_out",
]);
const VALID_CRAFT_TRANSITION = new Set<NonNullable<CraftDirective["transition_out"]>>([
  "hard_cut",
  "dissolve",
  "dip_to_black",
  "j_cut",
  "l_cut",
  "match_cut",
]);
const VALID_CRAFT_RHYTHM = new Set<NonNullable<CraftDirective["rhythm"]>>([
  "accelerando",
  "ritardando",
  "steady",
  "syncopated",
  "breath",
]);
const VALID_CRAFT_SHOT_PROGRESSION = new Set<NonNullable<CraftDirective["shot_progression"]>>([
  "wide_to_close",
  "close_to_wide",
  "scale_match",
  "free",
]);
const ALLOWED_REVISION_FIELDS = new Set([
  "purpose",
  "notes",
  "target_duration_frames",
  "craft.in_point",
  "craft.out_point",
  "craft.transition_in",
  "craft.transition_out",
  "craft.rhythm",
  "craft.shot_progression",
  "craft.beat_sync",
  "craft.hold_duration_bias",
  "candidate_plan.primary_candidate_ref",
  "candidate_plan.fallback_candidate_refs",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  const n = numberValue(value);
  if (n === undefined || n <= 0) return undefined;
  return Math.trunc(n);
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item.length > 0);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function enumValue<T extends string>(value: unknown, allowed: Set<T>): T | undefined {
  const raw = stringValue(value);
  return raw && allowed.has(raw as T) ? (raw as T) : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function cloneBlueprint(blueprint: EditBlueprint): EditBlueprint {
  return JSON.parse(JSON.stringify(blueprint)) as EditBlueprint;
}

function compactBrief(brief: CreativeBrief): Record<string, unknown> {
  const briefRecord = brief as Record<string, unknown>;
  const project = recordValue(brief.project) ?? {};
  const message = recordValue(brief.message) ?? {};
  const editorial = recordValue(brief.editorial) ?? {};
  return {
    project_id: stringValue(brief.project_id) ?? stringValue(project.id),
    title: stringValue(project.title),
    runtime_target_sec: numberValue(project.runtime_target_sec),
    duration_mode: stringValue(project.duration_mode),
    message: {
      primary: stringValue(message.primary),
      secondary: stringArray(message.secondary),
    },
    must_have: stringArray(briefRecord.must_have),
    must_avoid: stringArray(briefRecord.must_avoid),
    emotion_curve: stringArray(brief.emotion_curve),
    order_policy: stringValue(brief.order_policy),
    audio_policy: stringValue(brief.audio_policy),
    editorial: {
      hook_priority: stringValue(editorial.hook_priority),
      credibility_bias: stringValue(editorial.credibility_bias),
      profile_hint: stringValue(editorial.profile_hint),
      policy_hint: stringValue(editorial.policy_hint),
    },
  };
}

function candidateRefsForBeat(beat: Beat): string[] {
  const plan = beat.candidate_plan;
  return uniqueStrings([
    ...(plan?.primary_candidate_ref ? [plan.primary_candidate_ref] : []),
    ...(plan?.fallback_candidate_refs ?? []),
  ]);
}

function compactBeatForPrompt(beat: Beat, availableCandidateCount: number): Record<string, unknown> {
  return {
    id: beat.id,
    label: beat.label,
    story_role: beat.story_role,
    purpose: beat.purpose,
    target_duration_frames: beat.target_duration_frames,
    required_roles: beat.required_roles,
    preferred_roles: beat.preferred_roles,
    craft: beat.craft ?? null,
    candidate_plan: beat.candidate_plan ?? null,
    planned_candidate_count: candidateRefsForBeat(beat).length,
    available_candidate_count: availableCandidateCount,
  };
}

function overlaps(candidate: CompactBlueprintCandidate, event: MarlinEvent): boolean {
  if (candidate.src_in_us === undefined || candidate.src_out_us === undefined) return true;
  return event.start_us < candidate.src_out_us && event.end_us > candidate.src_in_us;
}

function compactMarlinEvidence(
  candidates: CompactBlueprintCandidate[],
  marlinEvents: MarlinEventsArtifact | null,
): Array<Record<string, unknown>> {
  if (!marlinEvents) return [];
  const byAsset = new Map(marlinEvents.items.map((item) => [item.asset_id, item]));
  return candidates.slice(0, 80).map((candidate) => {
    const item = candidate.asset_id ? byAsset.get(candidate.asset_id) : undefined;
    const events = item?.events
      .filter((event) => overlaps(candidate, event))
      .slice(0, 4)
      .map((event) => ({
        start_us: event.start_us,
        end_us: event.end_us,
        description: event.description,
        confidence: event.confidence,
      })) ?? [];
    return {
      candidate_ref: candidate.candidate_ref,
      segment_id: candidate.segment_id,
      asset_id: candidate.asset_id,
      scene: item?.scene,
      events,
    };
  });
}

export function detectCraftProblems(blueprint: EditBlueprint): CraftIssue[] {
  const issues: CraftIssue[] = [];
  const beats = blueprint.beats ?? [];
  if (beats.length === 0) return issues;
  const firstBeatId = beats[0].id;
  const lastBeat = beats[beats.length - 1];
  const rhythms = beats
    .map((beat) => beat.craft?.rhythm)
    .filter((rhythm): rhythm is NonNullable<CraftDirective["rhythm"]> => Boolean(rhythm));
  if (beats.length > 2 && rhythms.length === beats.length && new Set(rhythms).size === 1) {
    issues.push({
      beat_id: firstBeatId,
      issue: `All ${beats.length} beats use rhythm "${rhythms[0]}".`,
      suggestion: "Vary rhythm across hook, build, breath, and closing beats.",
      severity: "improvement",
    });
  }

  const hasAnyTransition = beats.some((beat) => beat.craft?.transition_in || beat.craft?.transition_out);
  if (beats.length > 1 && !hasAnyTransition) {
    issues.push({
      beat_id: firstBeatId,
      issue: "No beat-level transitions are specified.",
      suggestion: "Specify hard cuts within a scene and dissolves or J/L cuts at scene changes.",
      severity: "improvement",
    });
  }

  const missingTrimIntent = beats.filter((beat) => !beat.craft?.in_point || !beat.craft?.out_point);
  if (missingTrimIntent.length > Math.floor(beats.length / 2)) {
    issues.push({
      beat_id: missingTrimIntent[0].id,
      issue: `${missingTrimIntent.length} beats lack in_point or out_point craft intent.`,
      suggestion: "Add cut_on_action, peak_hold, pre_roll_enter, or clean_in_clean_out where the beat purpose needs it.",
      severity: "improvement",
    });
  }

  const totalFrames = beats.reduce((sum, beat) => sum + Math.max(0, beat.target_duration_frames), 0);
  const openingRatio = totalFrames > 0 ? beats[0].target_duration_frames / totalFrames : 0;
  if (beats.length > 2 && openingRatio > 0.25) {
    issues.push({
      beat_id: firstBeatId,
      issue: "Opening beat consumes more than a quarter of the planned runtime.",
      suggestion: "Shorten the hook or split it so the edit reaches movement sooner.",
      severity: "improvement",
    });
  } else if (beats.length > 2 && openingRatio > 0 && openingRatio < 0.06) {
    issues.push({
      beat_id: firstBeatId,
      issue: "Opening beat is very short relative to the planned runtime.",
      suggestion: "Give the hook enough screen time to register before the support beat.",
      severity: "taste",
    });
  }

  if (beats.length > 2) {
    const durations = beats.map((beat) => beat.target_duration_frames);
    if (new Set(durations).size === 1) {
      issues.push({
        beat_id: firstBeatId,
        issue: "All beats have identical target durations.",
        suggestion: "Use shorter beats for turns and longer holds for emotional proof or resolution.",
        severity: "improvement",
      });
    }
  }

  if (lastBeat && lastBeat.story_role !== "closing" && !blueprint.ending_policy?.final_visual_strategy) {
    issues.push({
      beat_id: lastBeat.id,
      issue: "Closing beat is not explicitly marked as closing and ending policy has no final visual strategy.",
      suggestion: "Clarify how the final beat resolves the emotional curve.",
      severity: "improvement",
    });
  }

  return issues;
}

export function buildCraftReviewPrompt(input: {
  brief: CreativeBrief;
  selects: SelectsCandidates;
  blueprint: EditBlueprint;
  marlinEvents: MarlinEventsArtifact | null;
}): string {
  const candidateIndex = buildCandidateIndex(input.selects);
  const heuristicIssues = detectCraftProblems(input.blueprint);
  const beats = input.blueprint.beats.map((beat) => {
    const available = candidateIndex.refsByBeat.get(beat.id)?.length ?? 0;
    return compactBeatForPrompt(beat, available);
  });

  return [
    "You are the Editorial Craft Reviewer.",
    "Review a draft edit_blueprint.yaml before deterministic compile.",
    "Make the edit feel edited, not just assembled.",
    "",
    "Rules:",
    "- Read structured artifacts only.",
    "- Do not invent candidates, visual facts, commands, or timeline.json edits.",
    "- Revisions may only use these beat-level fields:",
    Array.from(ALLOWED_REVISION_FIELDS).sort().map((field) => `  - ${field}`).join("\n"),
    "- candidate_plan refs must already exist in the approved selects.",
    "- Return JSON only.",
    "",
    "Check common craft problems:",
    "- All beats same rhythm: suggest variation.",
    "- No transitions specified: suggest dissolves or J/L cuts at scene changes and hard cuts inside scenes.",
    "- No in_point/out_point: suggest based on beat purpose.",
    "- Opening beat too long or too short.",
    "- Closing beat does not feel resolved.",
    "- Monotonous clip durations within a beat.",
    "",
    "Required JSON shape:",
    JSON.stringify({
      verdict: "accept | revise | block",
      issues: [
        {
          beat_id: "b02",
          issue: "b02 has 9 clips all at 5s - needs rhythm variation",
          suggestion: "apply accelerando, front-load the hero clip",
          severity: "critical | improvement | taste",
        },
      ],
      revisions: [
        {
          beat_id: "b02",
          field: "craft.rhythm",
          old_value: "steady",
          new_value: "accelerando",
          rationale: "The middle beat should build energy.",
        },
      ],
      summary: "short craft judgment",
    }, null, 2),
    "",
    "## Creative brief",
    JSON.stringify(compactBrief(input.brief), null, 2),
    "",
    "## BGM and duration constraints",
    JSON.stringify({
      duration_policy: input.blueprint.duration_policy ?? null,
      blueprint_default_duration_target_sec: input.blueprint.pacing.default_duration_target_sec ?? null,
      bgm_duration_sec: input.blueprint.music_policy.bgm_duration_sec ?? null,
      music_policy: input.blueprint.music_policy,
    }, null, 2),
    "",
    "## Draft blueprint beats",
    JSON.stringify(beats, null, 2),
    "",
    "## Draft blueprint policies",
    JSON.stringify({
      sequence_goals: input.blueprint.sequence_goals,
      pacing: input.blueprint.pacing,
      story_arc: input.blueprint.story_arc,
      transition_policy: input.blueprint.transition_policy,
      ending_policy: input.blueprint.ending_policy,
      rejection_rules: input.blueprint.rejection_rules,
    }, null, 2),
    "",
    "## Approved selects",
    JSON.stringify({
      editorial_summary: input.selects.editorial_summary,
      candidates: candidateIndex.candidates.map((candidate) => ({
        candidate_ref: candidate.candidate_ref,
        segment_id: candidate.segment_id,
        asset_id: candidate.asset_id,
        role: candidate.role,
        why_it_matches: candidate.why_it_matches,
        confidence: candidate.confidence,
        eligible_beats: candidate.eligible_beats,
        evidence: candidate.evidence,
        transcript_excerpt: candidate.transcript_excerpt,
        motif_tags: candidate.motif_tags,
      })),
    }, null, 2),
    "",
    "## Marlin scene summaries and temporal events",
    JSON.stringify(compactMarlinEvidence(candidateIndex.candidates, input.marlinEvents), null, 2),
    "",
    "## Deterministic craft warnings to consider",
    JSON.stringify(heuristicIssues, null, 2),
  ].join("\n");
}

function parseTarget(target: string, blueprint: EditBlueprint): { beatId: string; field: string } | undefined {
  const indexMatch = target.match(/^beats\[(\d+)\]\.(.+)$/);
  if (indexMatch) {
    const beat = blueprint.beats[Number(indexMatch[1])];
    const field = indexMatch[2];
    return beat && field ? { beatId: beat.id, field } : undefined;
  }
  const idMatch = target.match(/^beats\[(?:id=)?['"]?([^'"\]]+)['"]?\]\.(.+)$/);
  if (idMatch) {
    return { beatId: idMatch[1], field: idMatch[2] };
  }
  return undefined;
}

function readBeatField(beat: Beat, field: string): unknown {
  switch (field) {
    case "purpose": return beat.purpose;
    case "notes": return beat.notes;
    case "target_duration_frames": return beat.target_duration_frames;
    case "candidate_plan.primary_candidate_ref": return beat.candidate_plan?.primary_candidate_ref;
    case "candidate_plan.fallback_candidate_refs": return beat.candidate_plan?.fallback_candidate_refs;
    case "craft.in_point": return beat.craft?.in_point;
    case "craft.out_point": return beat.craft?.out_point;
    case "craft.transition_in": return beat.craft?.transition_in;
    case "craft.transition_out": return beat.craft?.transition_out;
    case "craft.rhythm": return beat.craft?.rhythm;
    case "craft.shot_progression": return beat.craft?.shot_progression;
    case "craft.beat_sync": return beat.craft?.beat_sync;
    case "craft.hold_duration_bias": return beat.craft?.hold_duration_bias;
    default: return undefined;
  }
}

function canonicalSelectRef(value: unknown, selects: SelectsCandidates): string | undefined {
  const raw = stringValue(value);
  if (!raw) return undefined;
  return buildCandidateIndex(selects).canonicalByAlias.get(raw);
}

function normalizeRevisionValue(
  field: string,
  value: unknown,
  selects: SelectsCandidates,
): unknown | undefined {
  if (field === "purpose" || field === "notes") return stringValue(value);
  if (field === "target_duration_frames") return positiveInteger(value);
  if (field === "craft.in_point") return enumValue(value, VALID_CRAFT_IN_POINT);
  if (field === "craft.out_point") return enumValue(value, VALID_CRAFT_OUT_POINT);
  if (field === "craft.transition_in" || field === "craft.transition_out") {
    return enumValue(value, VALID_CRAFT_TRANSITION);
  }
  if (field === "craft.rhythm") return enumValue(value, VALID_CRAFT_RHYTHM);
  if (field === "craft.shot_progression") return enumValue(value, VALID_CRAFT_SHOT_PROGRESSION);
  if (field === "craft.beat_sync") return booleanValue(value);
  if (field === "craft.hold_duration_bias") {
    const n = numberValue(value);
    return n !== undefined && n > 0 ? n : undefined;
  }
  if (field === "candidate_plan.primary_candidate_ref") {
    return canonicalSelectRef(value, selects);
  }
  if (field === "candidate_plan.fallback_candidate_refs") {
    const refs = uniqueStrings(
      stringArray(value)
        .map((ref) => canonicalSelectRef(ref, selects))
        .filter((ref): ref is string => Boolean(ref)),
    );
    return refs.length > 0 ? refs : undefined;
  }
  return undefined;
}

function normalizeIssue(raw: unknown, beatIds: Set<string>, fallbackBeatId: string): CraftIssue | undefined {
  const source = recordValue(raw);
  if (!source) return undefined;
  const beatId = stringValue(source.beat_id) ?? fallbackBeatId;
  if (!beatIds.has(beatId)) return undefined;
  const issue = stringValue(source.issue);
  const suggestion = stringValue(source.suggestion);
  if (!issue || !suggestion) return undefined;
  return {
    beat_id: beatId,
    issue,
    suggestion,
    severity: enumValue(source.severity, VALID_SEVERITIES) ?? "improvement",
  };
}

function normalizeRevision(
  raw: unknown,
  blueprint: EditBlueprint,
  selects: SelectsCandidates,
): CraftRevision | undefined {
  const source = recordValue(raw);
  if (!source) return undefined;
  const target = stringValue(source.target);
  const parsedTarget = target ? parseTarget(target, blueprint) : undefined;
  const beatId = stringValue(source.beat_id) ?? parsedTarget?.beatId;
  const field = stringValue(source.field) ?? parsedTarget?.field;
  if (!beatId || !field || !ALLOWED_REVISION_FIELDS.has(field)) return undefined;
  const beat = blueprint.beats.find((item) => item.id === beatId);
  if (!beat) return undefined;
  const rawNewValue = source.new_value ?? source.value ?? source.replace_with;
  const newValue = normalizeRevisionValue(field, rawNewValue, selects);
  if (newValue === undefined) return undefined;
  const oldValue = readBeatField(beat, field);
  if (JSON.stringify(oldValue) === JSON.stringify(newValue)) return undefined;
  return {
    beat_id: beatId,
    field,
    old_value: oldValue,
    new_value: newValue,
    rationale: stringValue(source.rationale) ?? stringValue(source.reason) ?? "Craft review revision.",
  };
}

export function craftDecisionFromLlmResponse(
  parsed: Record<string, unknown>,
  blueprint: EditBlueprint,
  selects: SelectsCandidates,
): CraftDecision {
  const source = recordValue(parsed.decision) ?? parsed;
  const beatIds = new Set(blueprint.beats.map((beat) => beat.id));
  const fallbackBeatId = blueprint.beats[0]?.id ?? "";
  const rawIssues = Array.isArray(source.issues)
    ? source.issues
    : Array.isArray(source.craft_issues)
      ? source.craft_issues
      : [];
  const issues = rawIssues
    .map((issue) => normalizeIssue(issue, beatIds, fallbackBeatId))
    .filter((issue): issue is CraftIssue => Boolean(issue));
  const rawRevisions = Array.isArray(source.revisions)
    ? source.revisions
    : Array.isArray(source.blueprint_edits)
      ? source.blueprint_edits
      : [];
  const revisions = rawRevisions
    .map((revision) => normalizeRevision(revision, blueprint, selects))
    .filter((revision): revision is CraftRevision => Boolean(revision));
  const explicitVerdict = enumValue(source.verdict ?? source.status, VALID_VERDICTS) ?? "accept";
  const verdict: CraftVerdict = explicitVerdict === "accept" && revisions.length > 0
    ? "revise"
    : explicitVerdict;
  return {
    verdict,
    issues,
    revisions,
    summary: stringValue(source.summary) ?? "Craft review completed.",
  };
}

function buildRepairPrompt(originalPrompt: string, raw: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return [
    originalPrompt,
    "",
    "The previous response was not parseable as the required JSON object.",
    `Parse error: ${message}`,
    `Previous response excerpt: ${raw.slice(0, 1200)}`,
    "Return JSON only. No Markdown, prose, or code fences.",
  ].join("\n");
}

async function completeWithSingleJsonRetry(
  llm: LlmCompleter,
  prompt: string,
): Promise<Record<string, unknown>> {
  const first = await llm(prompt);
  try {
    return parseLlmResponse(first);
  } catch (firstError) {
    const second = await llm(buildRepairPrompt(prompt, first, firstError));
    try {
      return parseLlmResponse(second);
    } catch (secondError) {
      const message = secondError instanceof Error ? secondError.message : String(secondError);
      throw new Error(`Editorial craft review response was not valid JSON after retry: ${message}`);
    }
  }
}

export async function reviewBlueprintCraft(
  brief: CreativeBrief,
  selects: SelectsCandidates,
  blueprint: EditBlueprint,
  marlinEvents: MarlinEventsArtifact | null,
  options: CraftReviewOptions = {},
): Promise<CraftDecision> {
  if (!options.llm && !process.env.GEMINI_API_KEY) {
    return {
      verdict: "accept",
      issues: [],
      revisions: [],
      summary: "Craft review skipped because GEMINI_API_KEY is not set.",
    };
  }

  const model = options.model ?? process.env.CRAFT_REVIEW_MODEL ?? DEFAULT_CRAFT_REVIEW_MODEL;
  const llm = options.llm
    ?? ((prompt: string) => callGeminiJson(prompt, model, {
      retryLabel: "editorial-craft-review",
      maxOutputTokens: 16384,
      temperature: 0.2,
    }));
  const prompt = buildCraftReviewPrompt({ brief, selects, blueprint, marlinEvents });
  const parsed = await completeWithSingleJsonRetry(llm, prompt);
  return craftDecisionFromLlmResponse(parsed, blueprint, selects);
}

function normalizedApplyValue(field: string, value: unknown): unknown | undefined {
  if (field === "purpose" || field === "notes") return stringValue(value);
  if (field === "target_duration_frames") return positiveInteger(value);
  if (field === "craft.in_point") return enumValue(value, VALID_CRAFT_IN_POINT);
  if (field === "craft.out_point") return enumValue(value, VALID_CRAFT_OUT_POINT);
  if (field === "craft.transition_in" || field === "craft.transition_out") return enumValue(value, VALID_CRAFT_TRANSITION);
  if (field === "craft.rhythm") return enumValue(value, VALID_CRAFT_RHYTHM);
  if (field === "craft.shot_progression") return enumValue(value, VALID_CRAFT_SHOT_PROGRESSION);
  if (field === "craft.beat_sync") return booleanValue(value);
  if (field === "craft.hold_duration_bias") {
    const n = numberValue(value);
    return n !== undefined && n > 0 ? n : undefined;
  }
  if (field === "candidate_plan.primary_candidate_ref") return stringValue(value);
  if (field === "candidate_plan.fallback_candidate_refs") {
    const refs = uniqueStrings(stringArray(value));
    return refs.length > 0 ? refs : undefined;
  }
  return undefined;
}

function applyBeatRevision(beat: Beat, field: string, value: unknown): void {
  switch (field) {
    case "purpose":
      beat.purpose = value as string;
      break;
    case "notes":
      beat.notes = value as string;
      break;
    case "target_duration_frames":
      beat.target_duration_frames = value as number;
      break;
    case "candidate_plan.primary_candidate_ref":
      {
        const primary = value as string;
        const oldPrimary = beat.candidate_plan?.primary_candidate_ref;
        const fallbacks = uniqueStrings([
          ...(oldPrimary && oldPrimary !== primary ? [oldPrimary] : []),
          ...(beat.candidate_plan?.fallback_candidate_refs ?? []),
        ]).filter((ref) => ref !== primary);
        beat.candidate_plan = {
          primary_candidate_ref: primary,
          fallback_candidate_refs: fallbacks,
        };
      }
      break;
    case "candidate_plan.fallback_candidate_refs":
      beat.candidate_plan = {
        primary_candidate_ref: beat.candidate_plan?.primary_candidate_ref,
        fallback_candidate_refs: (value as string[])
          .filter((ref) => ref !== beat.candidate_plan?.primary_candidate_ref),
      };
      break;
    default: {
      const craftField = field.startsWith("craft.") ? field.slice("craft.".length) : "";
      if (!craftField) break;
      beat.craft = { ...(beat.craft ?? {}) };
      (beat.craft as Record<string, unknown>)[craftField] = value;
    }
  }
}

export function applyCraftRevisions(
  blueprint: EditBlueprint,
  decision: CraftDecision,
): EditBlueprint {
  const next = cloneBlueprint(blueprint);
  if (decision.verdict !== "revise") return next;
  for (const revision of decision.revisions) {
    if (!ALLOWED_REVISION_FIELDS.has(revision.field)) continue;
    const beat = next.beats.find((item) => item.id === revision.beat_id);
    if (!beat) continue;
    const value = normalizedApplyValue(revision.field, revision.new_value);
    if (value === undefined) continue;
    applyBeatRevision(beat, revision.field, value);
  }
  return next;
}

function formatValue(value: unknown): string {
  if (value === undefined) return "undefined";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

export function renderCraftReviewMarkdown(decision: CraftDecision, appliedRevisionCount = 0): string {
  const lines: string[] = [
    "# Editorial Craft Review",
    "",
    `Verdict: ${decision.verdict}`,
    `Applied revisions: ${appliedRevisionCount}`,
    "",
    "## Summary",
    decision.summary,
    "",
    "## Issues",
  ];

  if (decision.issues.length === 0) {
    lines.push("- None");
  } else {
    for (const issue of decision.issues) {
      lines.push(`- [${issue.severity}] ${issue.beat_id}: ${issue.issue}`);
      lines.push(`  Suggestion: ${issue.suggestion}`);
    }
  }

  lines.push("", "## Revisions");
  if (decision.revisions.length === 0) {
    lines.push("- None");
  } else {
    for (const revision of decision.revisions) {
      lines.push(
        `- ${revision.beat_id} ${revision.field}: ${formatValue(revision.old_value)} -> ${formatValue(revision.new_value)}`,
      );
      lines.push(`  Rationale: ${revision.rationale}`);
    }
  }

  return `${lines.join("\n")}\n`;
}
