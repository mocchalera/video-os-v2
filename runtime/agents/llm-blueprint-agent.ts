import { callGeminiJson } from "../connectors/gemini-json.js";
import { legacyCandidateId } from "../compiler/candidate-ref.js";
import type {
  Beat,
  CandidatePlan,
  CaptionPolicySource,
  ConfirmedPreferences,
  CraftDirective,
  DurationMode,
  DurationPolicy,
  EditBlueprint,
  Role,
  StoryArc,
  StoryArcStrategy,
  TrackLayout,
} from "../compiler/types.js";
import type {
  BlueprintAgent,
  BlueprintAgentContext,
  UncertaintyRegister,
} from "../commands/blueprint.js";
import { parseLlmResponse } from "./llm-json.js";
import type { LlmCompleter } from "./llm-triage-agent.js";

// Cockpit/repo-side editorial blueprinting should prefer Claude/Codex
// subscription agents. Gemini flash-lite remains the headless CLI fallback.
export const DEFAULT_BLUEPRINT_MODEL = "gemini-2.5-flash-lite";

const VALID_ROLES = new Set<Role>(["hero", "support", "transition", "texture", "dialogue"]);
const VALID_SELECT_ROLES = new Set<Role | "reject">(["hero", "support", "transition", "texture", "dialogue", "reject"]);
const VALID_STORY_ROLES = new Set<NonNullable<Beat["story_role"]>>(["hook", "setup", "experience", "closing"]);
const VALID_STORY_ARC_STRATEGIES = new Set<StoryArcStrategy>([
  "chronological",
  "peak_first",
  "testimonial_highlight",
  "problem_to_solution",
  "release_after_peak",
]);
const VALID_DURATION_MODES = new Set<DurationMode>(["strict", "guide"]);
const VALID_DURATION_SOURCES = new Set<DurationPolicy["source"]>([
  "explicit_brief",
  "profile_default",
  "global_default",
]);
const VALID_TARGET_SOURCES = new Set<DurationPolicy["target_source"]>([
  "explicit_brief",
  "material_total",
]);
const VALID_CAPTION_SOURCES = new Set<CaptionPolicySource>(["transcript", "authored", "none"]);
const VALID_CAPTION_DELIVERY = new Set(["burn_in", "sidecar", "both"] as const);
const VALID_TIMELINE_ORDER = new Set(["chronological", "editorial"] as const);
const VALID_TRACK_LAYOUT = new Set<TrackLayout>(["single", "multi"]);
const VALID_CRAFT_IN_POINT = new Set<NonNullable<CraftDirective["in_point"]>>([
  "cut_on_action",
  "peak_hold",
  "pre_roll_enter",
  "post_action_hold",
  "clean_in_clean_out",
]);
const VALID_CRAFT_TRANSITION = new Set<NonNullable<CraftDirective["transition_in"]>>([
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

export interface BlueprintPromptInput {
  projectId: string;
  autonomyMode: "full" | "collaborative";
  briefContent: unknown;
  blockersContent: unknown;
  selectsContent: unknown;
  styleContent: string | null;
}

export interface BlueprintNormalizeContext {
  projectId: string;
  autonomyMode: "full" | "collaborative";
  briefContent: unknown;
  selectsContent: unknown;
}

export interface CompactBlueprintCandidate {
  candidate_ref: string;
  aliases: string[];
  segment_id: string;
  asset_id?: string;
  src_in_us?: number;
  src_out_us?: number;
  role: Role;
  why_it_matches?: string;
  confidence?: number;
  semantic_rank?: number;
  eligible_beats: string[];
  evidence: string[];
  transcript_excerpt?: string;
  motif_tags: string[];
}

export interface CandidateIndex {
  candidates: CompactBlueprintCandidate[];
  canonicalByAlias: Map<string, string>;
  roleByRef: Map<string, Role>;
  refsByBeat: Map<string, string[]>;
}

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

function positiveNumber(value: unknown): number | undefined {
  const n = numberValue(value);
  return n !== undefined && n > 0 ? n : undefined;
}

function integerValue(value: unknown): number | undefined {
  const n = numberValue(value);
  if (n === undefined) return undefined;
  return Math.trunc(n);
}

function positiveInteger(value: unknown): number | undefined {
  const n = integerValue(value);
  return n !== undefined && n > 0 ? n : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  const n = integerValue(value);
  return n !== undefined && n >= 0 ? n : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
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

function clamp01(value: unknown): number | undefined {
  const n = numberValue(value);
  if (n === undefined) return undefined;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function compactBriefForPrompt(briefContent: unknown, projectId: string): Record<string, unknown> {
  const brief = recordValue(briefContent) ?? {};
  const project = recordValue(brief.project) ?? {};
  const message = recordValue(brief.message) ?? {};
  const editorial = recordValue(brief.editorial) ?? {};
  return {
    project_id: stringValue(brief.project_id) ?? projectId,
    title: stringValue(project.title),
    strategy: stringValue(project.strategy),
    runtime: {
      target_sec: positiveNumber(project.runtime_target_sec),
      duration_mode: enumValue(project.duration_mode, VALID_DURATION_MODES),
      order_policy: enumValue(brief.order_policy, VALID_TIMELINE_ORDER),
      caption_policy: stringValue(brief.caption_policy),
      audio_policy: stringValue(brief.audio_policy),
    },
    message: {
      primary: stringValue(message.primary),
      secondary: stringArray(message.secondary),
    },
    must_have: stringArray(brief.must_have),
    emotion_curve: stringArray(brief.emotion_curve),
    editorial: {
      profile_hint: stringValue(editorial.profile_hint) ?? stringValue(brief.editorial_profile_hint),
      policy_hint: stringValue(editorial.policy_hint) ?? stringValue(brief.editorial_policy_hint),
      hook_priority: stringValue(editorial.hook_priority),
      credibility_bias: stringValue(editorial.credibility_bias),
    },
  };
}

function compactSelectsForPrompt(selectsContent: unknown): Record<string, unknown> {
  const selects = recordValue(selectsContent) ?? {};
  const index = buildCandidateIndex(selectsContent);
  return {
    project_id: stringValue(selects.project_id),
    selection_notes: selects.selection_notes,
    editorial_summary: selects.editorial_summary,
    candidates: index.candidates.map((candidate) => ({
      candidate_ref: candidate.candidate_ref,
      segment_id: candidate.segment_id,
      asset_id: candidate.asset_id,
      src_in_us: candidate.src_in_us,
      src_out_us: candidate.src_out_us,
      role: candidate.role,
      why_it_matches: candidate.why_it_matches,
      confidence: candidate.confidence,
      semantic_rank: candidate.semantic_rank,
      eligible_beats: candidate.eligible_beats,
      evidence: candidate.evidence,
      transcript_excerpt: candidate.transcript_excerpt,
      motif_tags: candidate.motif_tags,
    })),
  };
}

function truncateForPrompt(value: string | null): string {
  if (!value) return "(no STYLE.md)";
  return value.length > 6000 ? `${value.slice(0, 6000)}\n[truncated]` : value;
}

export function buildLlmBlueprintPrompt(input: BlueprintPromptInput): string {
  const targetSec = runtimeTargetSec(input.briefContent) ?? 60;
  const fps = 24;
  const totalFrames = Math.round(targetSec * fps);
  const hookFrames = Math.round(totalFrames * 0.08);
  const middleFrames = Math.round(totalFrames * 0.7);
  const closingFrames = Math.round(totalFrames * 0.12);

  const outputExample = {
    version: "1",
    project_id: input.projectId,
    sequence_goals: [
      "Open with the strongest approved hook.",
      "Build the middle beats from approved selects only.",
      "Resolve with a warm final beat.",
    ],
    beats: [
      {
        id: "b01",
        label: "hook",
        purpose: "establish the emotional promise",
        target_duration_frames: hookFrames,
        required_roles: ["hero"],
        preferred_roles: ["support", "texture"],
        story_role: "hook",
        candidate_plan: {
          primary_candidate_ref: "use_a_candidate_ref_from_the_list",
          fallback_candidate_refs: ["use_other_candidate_refs_from_the_list"],
        },
        craft: {
          in_point: "cut_on_action",
          rhythm: "accelerando",
          transition_out: "dissolve",
        },
      },
    ],
    pacing: {
      opening_cadence: "brisk",
      middle_cadence: "varied",
      ending_cadence: "resolved",
      max_shot_length_frames: 180,
      default_duration_target_sec: targetSec,
    },
    story_arc: {
      summary: "one sentence story arc",
      strategy: "chronological",
      chronology_bias: "respect source chronology unless the brief asks otherwise",
      allow_time_reorder: false,
      causal_links: ["why beat 1 leads to beat 2"],
    },
    music_policy: {
      start_sparse: true,
      allow_release_late: true,
      entry_beat: "b02",
      avoid_anthemic_lift: true,
      permitted_energy_curve: "restrained_to_warm",
    },
    caption_policy: {
      language: "ja",
      delivery_mode: "burn_in",
      source: "transcript",
      styling_class: "clean-lower-third",
    },
    dialogue_policy: {
      preserve_natural_breath: true,
      avoid_wall_to_wall_voiceover: true,
      prioritize_lines: ["short approved line"],
    },
    transition_policy: {
      prefer_match_texture_over_flashy_fx: true,
      allow_hard_cuts: true,
      avoid_speed_ramps: true,
    },
    ending_policy: {
      should_feel: "warm and resolved",
      final_line_strategy: "one clear closing line",
      avoid_cta: true,
      final_hold_min_frames: 12,
    },
    rejection_rules: ["reject off-brief filler even when technically good"],
    duration_policy: {
      mode: "guide",
      source: "explicit_brief",
      target_source: "explicit_brief",
      target_duration_sec: targetSec,
      min_duration_sec: Math.round(targetSec * 0.75),
      max_duration_sec: Math.round(targetSec * 1.25),
      hard_gate: false,
      protect_vlm_peaks: true,
    },
    timeline_order: "editorial",
    track_layout: "single",
  };

  return [
    "あなたは Video OS の blueprint-planner です。",
    "brief と承認済み selects 候補だけを根拠に、編集設計として EditBlueprint JSON を作ってください。",
    "各 beat は story_arc と対応させ、candidate_plan.primary_candidate_ref は必ず下の selects の candidate_ref から選んでください。",
    "未知の候補や存在しない candidate_ref を作らないでください。迷う場合は fallback_candidate_refs に別の既存 candidate_ref を置いてください。",
    "brief の emotion_curve と pacing intent に基づいて、必要な beat だけに craft directives を割り当ててください。craft は任意です。",
    "For each beat, choose an in_point technique: use 'cut_on_action' for energetic beats, 'peak_hold' for emotional moments, 'clean_in_clean_out' for opening/closing, 'pre_roll_enter' for anticipation.",
    "Use accelerando for building energy, ritardando for emotional resolution.",
    "Use dissolve between different locations, hard_cut within the same scene.",
    "",
    "## Creative brief",
    JSON.stringify(compactBriefForPrompt(input.briefContent, input.projectId), null, 2),
    "",
    "## Approved selects candidates",
    JSON.stringify(compactSelectsForPrompt(input.selectsContent), null, 2),
    "",
    "## Unresolved blockers",
    JSON.stringify(input.blockersContent, null, 2),
    "",
    "## Style guide",
    truncateForPrompt(input.styleContent),
    "",
    "## Required output",
    "JSON のみを返してください。Markdown、説明文、前後テキストは不要です。",
    "EditBlueprint の主要フィールドだけを出力してください。additionalProperties:false の schema にない未知フィールドは出力しないでください。",
    "",
    "## Duration rules",
    `Target runtime is ${targetSec}s (${totalFrames} frames at ${fps}fps).`,
    `The sum of all beat target_duration_frames MUST equal approximately ${totalFrames} frames.`,
    "Create enough beats (typically 4-8) so that each beat has 20-60 seconds of content.",
    "Each beat should reference multiple candidates via candidate_plan — use primary + fallbacks to fill the beat duration.",
    `Example: for a ${targetSec}s video with 5 beats, each beat averages ${Math.round(targetSec / 5)}s (${Math.round(totalFrames / 5)} frames).`,
    "",
    "Shape example:",
    JSON.stringify(outputExample, null, 2),
  ].join("\n");
}

function candidateRows(selectsContent: unknown): Record<string, unknown>[] {
  if (Array.isArray(selectsContent)) return selectsContent.filter(isRecord);
  const selects = recordValue(selectsContent);
  const candidates = selects?.candidates;
  return Array.isArray(candidates) ? candidates.filter(isRecord) : [];
}

function roleFromCandidate(value: unknown): Role | undefined {
  const role = enumValue(value, VALID_SELECT_ROLES);
  return role && role !== "reject" ? role : undefined;
}

function candidateAliases(item: Record<string, unknown>): string[] {
  const aliases: string[] = [];
  const candidateId = stringValue(item.candidate_id);
  const segmentId = stringValue(item.segment_id);
  const srcInUs = integerValue(item.src_in_us);
  const srcOutUs = integerValue(item.src_out_us);
  if (candidateId) aliases.push(candidateId);
  if (segmentId && srcInUs !== undefined && srcOutUs !== undefined) {
    aliases.push(legacyCandidateId({ segment_id: segmentId, src_in_us: srcInUs, src_out_us: srcOutUs }));
  }
  if (segmentId) aliases.push(segmentId);
  return uniqueStrings(aliases);
}

export function buildCandidateIndex(selectsContent: unknown): CandidateIndex {
  const candidates: CompactBlueprintCandidate[] = [];
  const canonicalByAlias = new Map<string, string>();
  const roleByRef = new Map<string, Role>();
  const refsByBeat = new Map<string, string[]>();

  for (const item of candidateRows(selectsContent)) {
    const segmentId = stringValue(item.segment_id);
    const role = roleFromCandidate(item.role);
    if (!segmentId || !role) continue;

    const aliases = candidateAliases(item);
    if (aliases.length === 0) continue;
    const candidateRef = aliases[0];
    const compact: CompactBlueprintCandidate = {
      candidate_ref: candidateRef,
      aliases,
      segment_id: segmentId,
      asset_id: stringValue(item.asset_id),
      src_in_us: integerValue(item.src_in_us),
      src_out_us: integerValue(item.src_out_us),
      role,
      why_it_matches: stringValue(item.why_it_matches),
      confidence: clamp01(item.confidence),
      semantic_rank: positiveInteger(item.semantic_rank),
      eligible_beats: stringArray(item.eligible_beats),
      evidence: stringArray(item.evidence),
      transcript_excerpt: stringValue(item.transcript_excerpt),
      motif_tags: stringArray(item.motif_tags),
    };
    candidates.push(compact);

    for (const alias of aliases) {
      canonicalByAlias.set(alias, candidateRef);
      roleByRef.set(alias, role);
    }
    roleByRef.set(candidateRef, role);
    for (const beatId of compact.eligible_beats) {
      const existing = refsByBeat.get(beatId) ?? [];
      existing.push(candidateRef);
      refsByBeat.set(beatId, uniqueStrings(existing));
    }
  }

  return { candidates, canonicalByAlias, roleByRef, refsByBeat };
}

export function parseLlmBlueprintResponse(raw: string): Record<string, unknown> {
  return parseLlmResponse(raw);
}

function sourceBlueprintObject(parsed: Record<string, unknown>): Record<string, unknown> {
  return recordValue(parsed.blueprint) ?? parsed;
}

function runtimeTargetSec(briefContent: unknown): number | undefined {
  const brief = recordValue(briefContent);
  const project = recordValue(brief?.project);
  return positiveNumber(project?.runtime_target_sec) ?? positiveNumber(brief?.runtime_target_sec);
}

function briefDurationMode(briefContent: unknown): DurationMode | undefined {
  const brief = recordValue(briefContent);
  const project = recordValue(brief?.project);
  return enumValue(project?.duration_mode, VALID_DURATION_MODES);
}

function briefPrimaryMessage(briefContent: unknown): string | undefined {
  const brief = recordValue(briefContent);
  const message = recordValue(brief?.message);
  return stringValue(message?.primary);
}

function briefTimelineOrder(briefContent: unknown): "chronological" | "editorial" | undefined {
  const brief = recordValue(briefContent);
  return enumValue(brief?.order_policy, VALID_TIMELINE_ORDER);
}

function sanitizeRoleArray(value: unknown): Role[] {
  return uniqueStrings(stringArray(value)).filter((role): role is Role => VALID_ROLES.has(role as Role));
}

function canonicalizeRef(value: unknown, index: CandidateIndex): string | undefined {
  const ref = stringValue(value);
  return ref ? index.canonicalByAlias.get(ref) : undefined;
}

function sanitizeCandidatePlan(value: unknown, index: CandidateIndex): CandidatePlan | undefined {
  const raw = recordValue(value);
  if (!raw) return undefined;

  const fallbacks = uniqueStrings(
    stringArray(raw.fallback_candidate_refs)
      .map((ref) => canonicalizeRef(ref, index))
      .filter((ref): ref is string => Boolean(ref)),
  );
  const explicitPrimary = canonicalizeRef(raw.primary_candidate_ref, index);
  const primary = explicitPrimary ?? fallbacks.shift();
  if (!primary) return undefined;

  return {
    primary_candidate_ref: primary,
    fallback_candidate_refs: fallbacks.filter((ref) => ref !== primary),
  };
}

function inferCandidatePlanForBeat(
  beatId: string,
  requiredRoles: Role[],
  index: CandidateIndex,
): CandidatePlan | undefined {
  const eligible = index.refsByBeat.get(beatId) ?? [];
  const roleMatched = index.candidates
    .filter((candidate) => requiredRoles.includes(candidate.role))
    .map((candidate) => candidate.candidate_ref);
  const refs = uniqueStrings([...eligible, ...roleMatched, ...index.candidates.map((candidate) => candidate.candidate_ref)]);
  const primary = refs[0];
  if (!primary) return undefined;
  return {
    primary_candidate_ref: primary,
    fallback_candidate_refs: refs.slice(1, 4),
  };
}

function sanitizeCandidateConstraints(value: unknown): Beat["candidate_constraints"] | undefined {
  const raw = recordValue(value);
  if (!raw) return undefined;
  const out: NonNullable<Beat["candidate_constraints"]> = {};
  const allowInterviewerSupport = booleanValue(raw.allow_interviewer_support);
  if (allowInterviewerSupport !== undefined) out.allow_interviewer_support = allowInterviewerSupport;
  const forceUniqueUtterances = booleanValue(raw.force_unique_utterances);
  if (forceUniqueUtterances !== undefined) out.force_unique_utterances = forceUniqueUtterances;
  return Object.keys(out).length > 0 ? out : undefined;
}

function sanitizeCraftDirective(value: unknown): CraftDirective | undefined {
  const raw = recordValue(value);
  if (!raw) return undefined;

  const out: CraftDirective = {};
  const inPoint = enumValue(raw.in_point, VALID_CRAFT_IN_POINT);
  if (inPoint) out.in_point = inPoint;
  const transitionIn = enumValue(raw.transition_in, VALID_CRAFT_TRANSITION);
  if (transitionIn) out.transition_in = transitionIn;
  const transitionOut = enumValue(raw.transition_out, VALID_CRAFT_TRANSITION);
  if (transitionOut) out.transition_out = transitionOut;
  const rhythm = enumValue(raw.rhythm, VALID_CRAFT_RHYTHM);
  if (rhythm) out.rhythm = rhythm;
  const shotProgression = enumValue(raw.shot_progression, VALID_CRAFT_SHOT_PROGRESSION);
  if (shotProgression) out.shot_progression = shotProgression;
  const beatSync = booleanValue(raw.beat_sync);
  if (beatSync !== undefined) out.beat_sync = beatSync;
  const holdDurationBias = numberValue(raw.hold_duration_bias);
  if (holdDurationBias !== undefined && holdDurationBias > 0) {
    out.hold_duration_bias = holdDurationBias;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function sanitizeBeat(
  value: unknown,
  index: number,
  defaultDurationFrames: number,
  candidateIndex: CandidateIndex,
): Beat | undefined {
  const raw = recordValue(value);
  if (!raw) return undefined;

  const id = stringValue(raw.id) ?? `b${String(index + 1).padStart(2, "0")}`;
  const explicitPlan = sanitizeCandidatePlan(raw.candidate_plan, candidateIndex);
  const primaryRole = explicitPlan?.primary_candidate_ref
    ? candidateIndex.roleByRef.get(explicitPlan.primary_candidate_ref)
    : undefined;
  const requiredRoles = sanitizeRoleArray(raw.required_roles);
  const effectiveRequiredRoles: Role[] = requiredRoles.length > 0
    ? requiredRoles
    : primaryRole
      ? [primaryRole]
      : ["support"];

  const inferredPlan = explicitPlan ?? inferCandidatePlanForBeat(id, effectiveRequiredRoles, candidateIndex);
  const beat: Beat = {
    id,
    label: stringValue(raw.label) ?? id,
    target_duration_frames: positiveInteger(raw.target_duration_frames) ?? defaultDurationFrames,
    required_roles: effectiveRequiredRoles,
  };

  const purpose = stringValue(raw.purpose);
  if (purpose) beat.purpose = purpose;
  const preferredRoles = sanitizeRoleArray(raw.preferred_roles);
  if (preferredRoles.length > 0) beat.preferred_roles = preferredRoles;
  const notes = stringValue(raw.notes);
  if (notes) beat.notes = notes;
  const storyRole = enumValue(raw.story_role, VALID_STORY_ROLES);
  if (storyRole) beat.story_role = storyRole;
  const craft = sanitizeCraftDirective(raw.craft);
  if (craft) beat.craft = craft;
  const skillHints = stringArray(raw.skill_hints);
  if (skillHints.length > 0) beat.skill_hints = skillHints;
  if (inferredPlan) beat.candidate_plan = inferredPlan;
  const constraints = sanitizeCandidateConstraints(raw.candidate_constraints);
  if (constraints) beat.candidate_constraints = constraints;
  return beat;
}

function sanitizeConfirmedPreferences(
  value: unknown,
  autonomyMode: "full" | "collaborative",
  targetDurationSec: number,
): ConfirmedPreferences {
  const raw = recordValue(value) ?? {};
  const out: ConfirmedPreferences = {
    mode: autonomyMode,
    source: autonomyMode === "full" ? "ai_autonomous" : "human_confirmed",
    duration_target_sec: positiveNumber(raw.duration_target_sec) ?? targetDurationSec,
    confirmed_at: stringValue(raw.confirmed_at) ?? "headless-llm",
  };
  const structureChoice = stringValue(raw.structure_choice);
  if (structureChoice) out.structure_choice = structureChoice;
  const pacingNotes = stringValue(raw.pacing_notes);
  if (pacingNotes) out.pacing_notes = pacingNotes;
  return out;
}

function sanitizePacing(
  value: unknown,
  autonomyMode: "full" | "collaborative",
  targetDurationSec: number,
): EditBlueprint["pacing"] {
  const raw = recordValue(value) ?? {};
  const pacing: EditBlueprint["pacing"] = {
    opening_cadence: stringValue(raw.opening_cadence) ?? "brisk",
    middle_cadence: stringValue(raw.middle_cadence) ?? "varied",
    ending_cadence: stringValue(raw.ending_cadence) ?? "resolved",
    default_duration_target_sec: positiveNumber(raw.default_duration_target_sec) ?? targetDurationSec,
    confirmed_preferences: sanitizeConfirmedPreferences(raw.confirmed_preferences, autonomyMode, targetDurationSec),
  };
  const maxShotLength = positiveInteger(raw.max_shot_length_frames);
  if (maxShotLength !== undefined) pacing.max_shot_length_frames = maxShotLength;
  return pacing;
}

function sanitizeMusicPolicy(value: unknown, firstBeatId: string): EditBlueprint["music_policy"] {
  const raw = recordValue(value) ?? {};
  const policy: EditBlueprint["music_policy"] = {
    start_sparse: booleanValue(raw.start_sparse) ?? true,
    allow_release_late: booleanValue(raw.allow_release_late) ?? true,
    entry_beat: stringValue(raw.entry_beat) ?? firstBeatId,
  };
  const avoidAnthemicLift = booleanValue(raw.avoid_anthemic_lift);
  if (avoidAnthemicLift !== undefined) policy.avoid_anthemic_lift = avoidAnthemicLift;
  const permittedEnergyCurve = stringValue(raw.permitted_energy_curve);
  if (permittedEnergyCurve) policy.permitted_energy_curve = permittedEnergyCurve;
  const bgmAssetId = stringValue(raw.bgm_asset_id);
  if (bgmAssetId) policy.bgm_asset_id = bgmAssetId;
  const bgmSegmentId = stringValue(raw.bgm_segment_id);
  if (bgmSegmentId) policy.bgm_segment_id = bgmSegmentId;
  const bgmDurationSec = numberValue(raw.bgm_duration_sec);
  if (bgmDurationSec !== undefined && bgmDurationSec >= 0) policy.bgm_duration_sec = bgmDurationSec;
  return policy;
}

function sanitizeCaptionPolicy(value: unknown, briefContent: unknown): NonNullable<EditBlueprint["caption_policy"]> {
  const raw = recordValue(value) ?? {};
  const brief = recordValue(briefContent);
  const briefCaptionPolicy = stringValue(brief?.caption_policy);
  const defaultSource: CaptionPolicySource = briefCaptionPolicy === "off" ? "none" : "transcript";
  return {
    language: stringValue(raw.language) ?? "ja",
    delivery_mode: enumValue(raw.delivery_mode, VALID_CAPTION_DELIVERY) ?? "burn_in",
    source: enumValue(raw.source, VALID_CAPTION_SOURCES) ?? defaultSource,
    styling_class: stringValue(raw.styling_class) ?? "clean-lower-third",
  };
}

function sanitizeDialoguePolicy(value: unknown): EditBlueprint["dialogue_policy"] {
  const raw = recordValue(value) ?? {};
  const policy: EditBlueprint["dialogue_policy"] = {
    preserve_natural_breath: booleanValue(raw.preserve_natural_breath) ?? true,
    avoid_wall_to_wall_voiceover: booleanValue(raw.avoid_wall_to_wall_voiceover) ?? true,
  };
  const lines = stringArray(raw.prioritize_lines);
  if (lines.length > 0) policy.prioritize_lines = lines;
  return policy;
}

function sanitizeTransitionPolicy(value: unknown): NonNullable<EditBlueprint["transition_policy"]> {
  const raw = recordValue(value) ?? {};
  const policy: NonNullable<EditBlueprint["transition_policy"]> = {
    prefer_match_texture_over_flashy_fx: booleanValue(raw.prefer_match_texture_over_flashy_fx) ?? true,
  };
  const allowHardCuts = booleanValue(raw.allow_hard_cuts);
  if (allowHardCuts !== undefined) policy.allow_hard_cuts = allowHardCuts;
  const allowCrossfade = booleanValue(raw.allow_crossfade_for_time_passage);
  if (allowCrossfade !== undefined) policy.allow_crossfade_for_time_passage = allowCrossfade;
  const avoidSpeedRamps = booleanValue(raw.avoid_speed_ramps);
  if (avoidSpeedRamps !== undefined) policy.avoid_speed_ramps = avoidSpeedRamps;
  const dissolveOverlapFrames = nonNegativeInteger(raw.dissolve_overlap_frames);
  if (dissolveOverlapFrames !== undefined) policy.dissolve_overlap_frames = dissolveOverlapFrames;
  const keepMilestoneCutsClean = booleanValue(raw.keep_milestone_cuts_clean);
  if (keepMilestoneCutsClean !== undefined) policy.keep_milestone_cuts_clean = keepMilestoneCutsClean;
  return policy;
}

function sanitizeEndingPolicy(value: unknown): NonNullable<EditBlueprint["ending_policy"]> {
  const raw = recordValue(value) ?? {};
  const policy: NonNullable<EditBlueprint["ending_policy"]> = {
    should_feel: stringValue(raw.should_feel) ?? "resolved",
  };
  const finalLineStrategy = stringValue(raw.final_line_strategy);
  if (finalLineStrategy) policy.final_line_strategy = finalLineStrategy;
  const avoidCta = booleanValue(raw.avoid_cta);
  if (avoidCta !== undefined) policy.avoid_cta = avoidCta;
  const finalHold = nonNegativeInteger(raw.final_hold_min_frames);
  if (finalHold !== undefined) policy.final_hold_min_frames = finalHold;
  const finalVisualStrategy = stringValue(raw.final_visual_strategy);
  if (finalVisualStrategy) policy.final_visual_strategy = finalVisualStrategy;
  const finalAudioStrategy = stringValue(raw.final_audio_strategy);
  if (finalAudioStrategy) policy.final_audio_strategy = finalAudioStrategy;
  return policy;
}

function sanitizeStoryArc(value: unknown, sequenceGoals: string[], briefContent: unknown): StoryArc {
  const raw = recordValue(value) ?? {};
  const explicitOrder = briefTimelineOrder(briefContent);
  return {
    summary: stringValue(raw.summary) ?? sequenceGoals.join(" "),
    strategy: enumValue(raw.strategy, VALID_STORY_ARC_STRATEGIES)
      ?? (explicitOrder === "chronological" ? "chronological" : "peak_first"),
    chronology_bias: stringValue(raw.chronology_bias)
      ?? (explicitOrder === "chronological" ? "respect source chronology" : "brief-led editorial order"),
    allow_time_reorder: booleanValue(raw.allow_time_reorder) ?? explicitOrder !== "chronological",
    causal_links: stringArray(raw.causal_links),
  };
}

function sanitizeResolvedRef(value: unknown): EditBlueprint["resolved_profile"] {
  const raw = recordValue(value);
  if (!raw) return undefined;
  const id = stringValue(raw.id);
  if (!id) return undefined;
  const out: NonNullable<EditBlueprint["resolved_profile"]> = { id };
  const source = enumValue(raw.source, new Set(["explicit_hint", "inferred", "default"] as const));
  if (source) out.source = source;
  const rationale = stringValue(raw.rationale);
  if (rationale) out.rationale = rationale;
  return out;
}

function sanitizeDedupeRules(value: unknown): EditBlueprint["dedupe_rules"] {
  const raw = recordValue(value);
  if (!raw) return undefined;
  const out: NonNullable<EditBlueprint["dedupe_rules"]> = {};
  const utteranceConsumption = enumValue(raw.utterance_consumption, new Set(["unique", "allow_repeat"] as const));
  if (utteranceConsumption) out.utterance_consumption = utteranceConsumption;
  const threshold = clamp01(raw.semantic_similarity_threshold);
  if (threshold !== undefined) out.semantic_similarity_threshold = threshold;
  const allowIntentionalRepetition = booleanValue(raw.allow_intentional_repetition);
  if (allowIntentionalRepetition !== undefined) out.allow_intentional_repetition = allowIntentionalRepetition;
  return Object.keys(out).length > 0 ? out : undefined;
}

function sanitizeQualityTargets(value: unknown): EditBlueprint["quality_targets"] {
  const raw = recordValue(value);
  if (!raw) return undefined;
  const out: NonNullable<EditBlueprint["quality_targets"]> = {};
  const hookDensity = clamp01(raw.hook_density_min);
  if (hookDensity !== undefined) out.hook_density_min = hookDensity;
  const noveltyRate = clamp01(raw.novelty_rate_min);
  if (noveltyRate !== undefined) out.novelty_rate_min = noveltyRate;
  const tolerance = numberValue(raw.duration_pacing_tolerance_pct);
  if (tolerance !== undefined && tolerance >= 0) out.duration_pacing_tolerance_pct = tolerance;
  const emotionGradient = clamp01(raw.emotion_gradient_min);
  if (emotionGradient !== undefined) out.emotion_gradient_min = emotionGradient;
  const causalConnectivity = clamp01(raw.causal_connectivity_min);
  if (causalConnectivity !== undefined) out.causal_connectivity_min = causalConnectivity;
  return Object.keys(out).length > 0 ? out : undefined;
}

function sanitizeTrimPolicy(value: unknown): EditBlueprint["trim_policy"] {
  const raw = recordValue(value);
  if (!raw) return undefined;
  const out: NonNullable<EditBlueprint["trim_policy"]> = {};
  const mode = enumValue(raw.mode, new Set(["adaptive", "fixed", "center_first"] as const));
  if (mode) out.mode = mode;
  const preferred = positiveInteger(raw.default_preferred_duration_frames);
  if (preferred !== undefined) out.default_preferred_duration_frames = preferred;
  const min = positiveInteger(raw.default_min_duration_frames);
  if (min !== undefined) out.default_min_duration_frames = min;
  const max = positiveInteger(raw.default_max_duration_frames);
  if (max !== undefined) out.default_max_duration_frames = max;
  const actionCutGuard = booleanValue(raw.action_cut_guard);
  if (actionCutGuard !== undefined) out.action_cut_guard = actionCutGuard;
  return Object.keys(out).length > 0 ? out : undefined;
}

function sanitizeDurationPolicy(value: unknown, briefContent: unknown, targetDurationSec: number): DurationPolicy {
  const raw = recordValue(value) ?? {};
  const mode = enumValue(raw.mode, VALID_DURATION_MODES) ?? briefDurationMode(briefContent) ?? "guide";
  const source = enumValue(raw.source, VALID_DURATION_SOURCES)
    ?? (runtimeTargetSec(briefContent) ? "explicit_brief" : "global_default");
  const targetSource = enumValue(raw.target_source, VALID_TARGET_SOURCES)
    ?? (runtimeTargetSec(briefContent) ? "explicit_brief" : "material_total");
  const target = positiveNumber(raw.target_duration_sec) ?? targetDurationSec;
  const min = numberValue(raw.min_duration_sec);
  const rawMaxNumber = raw.max_duration_sec === null ? null : numberValue(raw.max_duration_sec);
  const max = rawMaxNumber === null
    ? null
    : rawMaxNumber !== undefined && rawMaxNumber >= 0
      ? rawMaxNumber
      : Math.round(target * 1.3);
  return {
    mode,
    source,
    target_source: targetSource,
    target_duration_sec: target,
    min_duration_sec: min !== undefined && min >= 0 ? min : Math.max(0, Math.round(target * 0.7)),
    max_duration_sec: max,
    hard_gate: booleanValue(raw.hard_gate) ?? mode === "strict",
    protect_vlm_peaks: booleanValue(raw.protect_vlm_peaks) ?? true,
  };
}

export function blueprintFromLlmResponse(
  parsed: Record<string, unknown>,
  ctx: BlueprintNormalizeContext,
): EditBlueprint {
  const source = sourceBlueprintObject(parsed);
  const candidateIndex = buildCandidateIndex(ctx.selectsContent);
  const rawBeats = Array.isArray(source.beats) ? source.beats : [];
  if (rawBeats.length === 0) {
    throw new Error("LLM blueprint response must include a non-empty beats array");
  }

  const targetDurationSec = runtimeTargetSec(ctx.briefContent) ?? 60;
  const defaultDurationFrames = Math.max(1, Math.round((targetDurationSec * 30) / rawBeats.length));
  const beats = rawBeats
    .map((beat, index) => sanitizeBeat(beat, index, defaultDurationFrames, candidateIndex))
    .filter((beat): beat is Beat => Boolean(beat));
  if (beats.length === 0) {
    throw new Error("LLM blueprint response did not contain any usable beats");
  }

  const sequenceGoals = stringArray(source.sequence_goals);
  const effectiveSequenceGoals = sequenceGoals.length > 0
    ? sequenceGoals
    : [briefPrimaryMessage(ctx.briefContent) ?? "Create a message-first edit from the approved selects."];
  const firstBeatId = beats[0]?.id ?? "b01";

  const blueprint: EditBlueprint = {
    version: stringValue(source.version) ?? "1",
    project_id: ctx.projectId,
    sequence_goals: effectiveSequenceGoals,
    beats,
    pacing: sanitizePacing(source.pacing, ctx.autonomyMode, targetDurationSec),
    music_policy: sanitizeMusicPolicy(source.music_policy, firstBeatId),
    caption_policy: sanitizeCaptionPolicy(source.caption_policy, ctx.briefContent),
    dialogue_policy: sanitizeDialoguePolicy(source.dialogue_policy),
    transition_policy: sanitizeTransitionPolicy(source.transition_policy),
    ending_policy: sanitizeEndingPolicy(source.ending_policy),
    rejection_rules: stringArray(source.rejection_rules).length > 0
      ? stringArray(source.rejection_rules)
      : ["Reject candidates that do not support the brief or approved selects."],
    story_arc: sanitizeStoryArc(source.story_arc, effectiveSequenceGoals, ctx.briefContent),
    duration_policy: sanitizeDurationPolicy(source.duration_policy, ctx.briefContent, targetDurationSec),
    timeline_order: enumValue(source.timeline_order, VALID_TIMELINE_ORDER)
      ?? briefTimelineOrder(ctx.briefContent)
      ?? "editorial",
    track_layout: enumValue(source.track_layout, VALID_TRACK_LAYOUT) ?? "single",
  };

  const resolvedProfile = sanitizeResolvedRef(source.resolved_profile);
  if (resolvedProfile) blueprint.resolved_profile = resolvedProfile;
  const resolvedPolicy = sanitizeResolvedRef(source.resolved_policy);
  if (resolvedPolicy) blueprint.resolved_policy = resolvedPolicy;
  const activeEditingSkills = stringArray(source.active_editing_skills);
  if (activeEditingSkills.length > 0) blueprint.active_editing_skills = activeEditingSkills;
  const dedupeRules = sanitizeDedupeRules(source.dedupe_rules);
  if (dedupeRules) blueprint.dedupe_rules = dedupeRules;
  const qualityTargets = sanitizeQualityTargets(source.quality_targets);
  if (qualityTargets) blueprint.quality_targets = qualityTargets;
  const trimPolicy = sanitizeTrimPolicy(source.trim_policy);
  if (trimPolicy) blueprint.trim_policy = trimPolicy;

  return blueprint;
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
    return parseLlmBlueprintResponse(first);
  } catch (firstError) {
    const second = await llm(buildRepairPrompt(prompt, first, firstError));
    try {
      return parseLlmBlueprintResponse(second);
    } catch (secondError) {
      const message = secondError instanceof Error ? secondError.message : String(secondError);
      throw new Error(`LLM blueprint response was not valid JSON after retry: ${message}`);
    }
  }
}

function emptyUncertaintyRegister(projectId: string): UncertaintyRegister {
  return {
    version: "1",
    project_id: projectId,
    uncertainties: [],
  };
}

export function createLlmBlueprintAgent(opts: { llm?: LlmCompleter; model?: string } = {}): BlueprintAgent {
  const model = opts.model ?? process.env.BLUEPRINT_MODEL ?? DEFAULT_BLUEPRINT_MODEL;
  const llm = opts.llm
    ?? ((prompt: string) => callGeminiJson(prompt, model, { retryLabel: "blueprint-llm", maxOutputTokens: 32768 }));

  return {
    async run(ctx: BlueprintAgentContext) {
      const prompt = buildLlmBlueprintPrompt({
        projectId: ctx.projectId,
        autonomyMode: ctx.autonomyMode,
        briefContent: ctx.briefContent,
        blockersContent: ctx.blockersContent,
        selectsContent: ctx.selectsContent,
        styleContent: ctx.styleContent,
      });
      const parsed = await completeWithSingleJsonRetry(llm, prompt);
      return {
        blueprint: blueprintFromLlmResponse(parsed, {
          projectId: ctx.projectId,
          autonomyMode: ctx.autonomyMode,
          briefContent: ctx.briefContent,
          selectsContent: ctx.selectsContent,
        }),
        uncertaintyRegister: emptyUncertaintyRegister(ctx.projectId),
        confirmed: true,
      };
    },
  };
}
