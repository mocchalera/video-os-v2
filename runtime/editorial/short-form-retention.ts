import type { EditBlueprint } from "../compiler/types.js";

export type ShortFormRetentionMode = "off" | "standard" | "aggressive" | "credibility_first";

export interface ShortFormRetentionProfile {
  enabled: boolean;
  mode: ShortFormRetentionMode;
  target_duration_sec: number | null;
  cold_open_max_frames: number | null;
  full_payoff_latest_ratio: number | null;
  reasons: string[];
}

export interface ShortFormRetentionIssue {
  code:
    | "cold_open_missing"
    | "cold_open_too_long"
    | "peak_first_missing"
    | "payoff_candidate_missing"
    | "payoff_too_late"
    | "system_label_exposed"
    | "visual_refresh_plan_missing";
  message: string;
}

const SOCIAL_CHANNEL_PATTERN = /(?:social|shorts|reels|tiktok|feed)/i;
const SOCIAL_FORMAT_PATTERN = /(?:social|short|vertical)/i;
const COLD_OPEN_PATTERN = /(?:cold[\s_-]*open|コールドオープン|先出し|冒頭.{0,8}(?:完成|結果|ピーク)|0\s*[〜～~-]\s*2秒)/i;
const CREDIBILITY_FIRST_PATTERN = /(?:credibility[_\s-]*first|信頼(?:性)?優先|信用(?:性)?優先)/i;
const SYSTEM_LABEL_PATTERN = /^(?:(?:b\d+)[\s_-]*)?(?:hook|setup|experience|escalation|turn|level\s*\d+|payoff|ending|closing|resolution|end|フック|セットアップ|レベル\s*\d+|ペイオフ|エンディング|エンド)$/i;
const VISUAL_REFRESH_PATTERN = /(?:punch_in_emphasis|shot_reverse_reaction|リアクション|リフレーム|パンチイン|寄り引き|画角変化|カットアウェイ|インサート|強調語|視覚(?:更新|変化)|visual refresh|reaction insert|reframe|punch[\s_-]*in|cutaway)/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function recordValue(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function numberValue(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean)
    : [];
}

function briefMustHave(brief: Record<string, unknown>): string[] {
  return stringArray(brief.must_have);
}

/**
 * Derive retention behavior from explicit delivery/runtime fields, not genre guesses.
 * The aggressive cold-open rule is intentionally narrower than the base short-social rule.
 */
export function deriveShortFormRetentionProfile(briefInput: unknown): ShortFormRetentionProfile {
  const brief = recordValue(briefInput);
  const project = recordValue(brief.project);
  const editorial = recordValue(brief.editorial);
  const targetDurationSec = numberValue(project.runtime_target_sec);
  const distribution = stringValue(editorial.distribution_channel);
  const format = stringValue(project.format);
  const aspectRatio = stringValue(editorial.aspect_ratio);
  const profileHint = stringValue(editorial.profile_hint);
  const hookPriority = stringValue(editorial.hook_priority);
  const credibilityBias = stringValue(editorial.credibility_bias);
  const mustHaveText = briefMustHave(brief).join("\n");

  const socialDelivery = SOCIAL_CHANNEL_PATTERN.test(distribution) || SOCIAL_FORMAT_PATTERN.test(format);
  const shortRuntime = targetDurationSec !== null && targetDurationSec <= 90;
  const longformRoute = /(?:longform|lecture|event)/i.test(profileHint) && !SOCIAL_CHANNEL_PATTERN.test(distribution);
  const enabled = socialDelivery && shortRuntime && !longformRoute;
  const reasons: string[] = [];
  if (socialDelivery) reasons.push("explicit social delivery");
  if (aspectRatio === "9:16") reasons.push("vertical 9:16 delivery");
  if (shortRuntime) reasons.push(`runtime ${targetDurationSec}s is within short-form limit`);

  if (!enabled) {
    return {
      enabled: false,
      mode: "off",
      target_duration_sec: targetDurationSec,
      cold_open_max_frames: null,
      full_payoff_latest_ratio: null,
      reasons,
    };
  }

  const credibilityFirst = CREDIBILITY_FIRST_PATTERN.test(hookPriority)
    || CREDIBILITY_FIRST_PATTERN.test(stringValue(editorial.policy_hint))
    || credibilityBias.toLowerCase() === "high";
  if (credibilityFirst) {
    return {
      enabled: true,
      mode: "credibility_first",
      target_duration_sec: targetDurationSec,
      cold_open_max_frames: null,
      full_payoff_latest_ratio: null,
      reasons: [...reasons, "credibility-first guard"],
    };
  }

  const aggressive = /aggressive/i.test(hookPriority) || COLD_OPEN_PATTERN.test(mustHaveText);
  return {
    enabled: true,
    mode: aggressive ? "aggressive" : "standard",
    target_duration_sec: targetDurationSec,
    cold_open_max_frames: aggressive ? 48 : null,
    full_payoff_latest_ratio: aggressive ? 0.65 : null,
    reasons: aggressive ? [...reasons, "explicit aggressive/cold-open intent"] : reasons,
  };
}

export function shortFormRetentionPromptLines(briefInput: unknown): string[] {
  const profile = deriveShortFormRetentionProfile(briefInput);
  if (!profile.enabled) return [];

  const lines = [
    "## Short-social retention contract",
    "- Keep structural ids such as b01_hook internal. Write beat.viewer_label as audience-facing story language; do not expose HOOK, LEVEL 1, PAYOFF, ENDING, or similar editor labels unless the brief explicitly requests that vocabulary.",
    "- For a low-motion or talking-head source, plan a meaningful visual refresh every 6-12 seconds at semantic turns: an actual reaction/cutaway, a registered reframe or punch-in, or a registered emphasis overlay. Do not add arbitrary zooms, flashes, or decorative transitions.",
    "- Preserve source truth. A retention device may reorder or preview real material, but it may not invent a reaction, result, quote, or capability.",
  ];

  if (profile.mode === "aggressive") {
    lines.push(
      "- Create a distinct 1-2 second cold-open beat from the strongest honest payoff/reaction moment, then return to setup and rebuild toward the complete payoff.",
      "- Start the complete payoff by roughly 65% of total runtime when the premise is already clear; shorten repetitive setup before delaying the result.",
      "- Prefer a separate source range for the teaser. If the same asset or semantic cluster intentionally returns, declare beat.allow_revisit with a concrete callback reason.",
    );
  } else if (profile.mode === "credibility_first") {
    lines.push(
      "- Do not force a spoiler montage or fragmentary payoff tease. Open on the strongest complete, credible assertion and retain the nearby reason or evidence.",
    );
  }

  return lines;
}

function usesJapaneseAudienceCopy(briefInput: unknown): boolean {
  const brief = recordValue(briefInput);
  const message = recordValue(brief.message);
  const audience = recordValue(brief.audience);
  return /[ぁ-んァ-ヶ一-龠]/.test([
    stringValue(message.primary),
    stringValue(audience.primary),
  ].join(" "));
}

function fallbackViewerLabel(index: number, count: number, japanese: boolean): string {
  if (index === 0) return japanese ? "先に結果をどうぞ" : "First, the result";
  if (index === count - 1) return japanese ? "そして結末" : "And the result";
  const ratio = count <= 1 ? 0 : index / (count - 1);
  if (ratio < 0.4) return japanese ? "きっかけはここから" : "How it started";
  if (ratio < 0.7) return japanese ? "予想外の展開" : "Then it escalated";
  return japanese ? "ついに本気" : "Finally, the real thing";
}

function candidateRows(selectsInput: unknown): Record<string, unknown>[] {
  const selects = recordValue(selectsInput);
  return Array.isArray(selects.candidates) ? selects.candidates.filter(isRecord) : [];
}

function candidateRefs(candidate: Record<string, unknown>): string[] {
  return [candidate.candidate_id, candidate.segment_id]
    .map(stringValue)
    .filter(Boolean);
}

function candidateByStoryRole(selectsInput: unknown, role: string): Record<string, unknown> | undefined {
  return candidateRows(selectsInput).find((candidate) => stringValue(candidate.story_role) === role);
}

function preferredCandidateRef(candidate: Record<string, unknown> | undefined): string | undefined {
  if (!candidate) return undefined;
  return stringValue(candidate.candidate_id) || stringValue(candidate.segment_id) || undefined;
}

function redistributeOpeningFrames(blueprint: EditBlueprint, maxOpeningFrames: number): void {
  const firstBeat = blueprint.beats[0];
  if (!firstBeat || firstBeat.target_duration_frames <= maxOpeningFrames || blueprint.beats.length < 2) return;
  const recovered = firstBeat.target_duration_frames - maxOpeningFrames;
  firstBeat.target_duration_frames = maxOpeningFrames;
  const rest = blueprint.beats.slice(1);
  const each = Math.floor(recovered / rest.length);
  let remainder = recovered - each * rest.length;
  for (const beat of rest) {
    beat.target_duration_frames += each + (remainder > 0 ? 1 : 0);
    if (remainder > 0) remainder -= 1;
  }
}

function pullPayoffEarlier(blueprint: EditBlueprint, payoffIndex: number, latestRatio: number): void {
  if (payoffIndex <= 0 || payoffIndex >= blueprint.beats.length) return;
  const totalFrames = blueprint.beats.reduce((sum, beat) => sum + beat.target_duration_frames, 0);
  const payoffStart = blueprint.beats
    .slice(0, payoffIndex)
    .reduce((sum, beat) => sum + beat.target_duration_frames, 0);
  let excess = payoffStart - Math.floor(totalFrames * latestRatio);
  if (excess <= 0) return;

  const reducible = blueprint.beats.slice(1, payoffIndex).sort((a, b) => b.target_duration_frames - a.target_duration_frames);
  let recovered = 0;
  for (const beat of reducible) {
    if (excess <= 0) break;
    const available = Math.max(0, beat.target_duration_frames - 24);
    const take = Math.min(available, excess);
    beat.target_duration_frames -= take;
    excess -= take;
    recovered += take;
  }
  blueprint.beats[payoffIndex].target_duration_frames += recovered;
}

/**
 * Improve deterministic/degraded blueprints without changing non-short-social work.
 * This is deliberately conservative: it uses only selected candidate refs and existing skills.
 */
export function applyShortFormRetentionDefaults(
  briefInput: unknown,
  blueprintInput: EditBlueprint,
  selectsInput?: unknown,
): EditBlueprint {
  const profile = deriveShortFormRetentionProfile(briefInput);
  if (!profile.enabled) return blueprintInput;

  const blueprint: EditBlueprint = {
    ...blueprintInput,
    sequence_goals: [...blueprintInput.sequence_goals],
    beats: blueprintInput.beats.map((beat) => ({
      ...beat,
      preferred_roles: beat.preferred_roles ? [...beat.preferred_roles] : undefined,
      skill_hints: beat.skill_hints ? [...beat.skill_hints] : undefined,
      candidate_plan: beat.candidate_plan
        ? {
          ...beat.candidate_plan,
          fallback_candidate_refs: [...(beat.candidate_plan.fallback_candidate_refs ?? [])],
        }
        : undefined,
    })),
    story_arc: blueprintInput.story_arc ? { ...blueprintInput.story_arc } : {},
    active_editing_skills: [...(blueprintInput.active_editing_skills ?? [])],
  };

  const japanese = usesJapaneseAudienceCopy(briefInput);
  blueprint.beats.forEach((beat, index) => {
    if (!beat.viewer_label || SYSTEM_LABEL_PATTERN.test(beat.viewer_label)) {
      beat.viewer_label = fallbackViewerLabel(index, blueprint.beats.length, japanese);
    }
  });

  const skills = new Set(blueprint.active_editing_skills);
  if (profile.mode === "aggressive") {
    skills.add("build_to_peak");
    skills.add("reveal_then_payoff");
  }
  if (isLowMotionSource(selectsInput)) {
    if (profile.mode === "aggressive") {
      skills.add("punch_in_emphasis");
      skills.add("shot_reverse_reaction");
    }
    if (!blueprint.sequence_goals.some((goal) => VISUAL_REFRESH_PATTERN.test(goal))) {
      blueprint.sequence_goals.push(
        japanese
          ? "意味が転換する6〜12秒ごとに、実在リアクションまたは登録済みリフレーム・強調表示で画面を更新する。"
          : "Refresh the low-motion frame at semantic turns every 6-12 seconds using real reactions or registered reframes/emphasis.",
      );
    }
  }
  blueprint.active_editing_skills = [...skills];

  if (profile.mode !== "aggressive") return blueprint;

  const firstBeat = blueprint.beats[0];
  if (firstBeat) {
    firstBeat.story_role = "hook";
    if (profile.cold_open_max_frames !== null) {
      redistributeOpeningFrames(blueprint, profile.cold_open_max_frames);
    }
  }
  blueprint.story_arc = {
    ...blueprint.story_arc,
    strategy: "peak_first",
    allow_time_reorder: true,
    chronology_bias: blueprint.story_arc?.chronology_bias ?? "brief-led cold open, then causal rebuild",
  };

  const hookCandidate = candidateByStoryRole(selectsInput, "hook");
  const payoffCandidate = candidateByStoryRole(selectsInput, "payoff");
  const teaserRef = preferredCandidateRef(hookCandidate) ?? preferredCandidateRef(payoffCandidate);
  const payoffRef = preferredCandidateRef(payoffCandidate);
  if (firstBeat && teaserRef) {
    const previousPrimary = firstBeat.candidate_plan?.primary_candidate_ref;
    firstBeat.candidate_plan = {
      primary_candidate_ref: teaserRef,
      fallback_candidate_refs: [previousPrimary, ...(firstBeat.candidate_plan?.fallback_candidate_refs ?? [])]
        .filter((ref): ref is string => Boolean(ref) && ref !== teaserRef),
    };
  }

  if (payoffRef && blueprint.beats.length >= 2) {
    const existingPayoffIndex = blueprint.beats.findIndex((beat, index) =>
      index > 0 && [
        beat.candidate_plan?.primary_candidate_ref,
        ...(beat.candidate_plan?.fallback_candidate_refs ?? []),
      ].includes(payoffRef)
    );
    const targetIndex = existingPayoffIndex >= 0
      ? existingPayoffIndex
      : Math.max(1, Math.min(blueprint.beats.length - 1, Math.floor(blueprint.beats.length * 0.55)));
    const payoffBeat = blueprint.beats[targetIndex];
    if (payoffBeat && existingPayoffIndex < 0) {
      const previousPrimary = payoffBeat.candidate_plan?.primary_candidate_ref;
      payoffBeat.candidate_plan = {
        primary_candidate_ref: payoffRef,
        fallback_candidate_refs: [previousPrimary, ...(payoffBeat.candidate_plan?.fallback_candidate_refs ?? [])]
          .filter((ref): ref is string => Boolean(ref) && ref !== payoffRef),
      };
    }
    if (payoffBeat && teaserRef === payoffRef) {
      const payoffAssetId = stringValue(payoffCandidate?.asset_id);
      payoffBeat.allow_revisit = {
        ...(payoffAssetId ? { asset_ids: [payoffAssetId] } : {}),
        reason: "intentional cold-open callback to the complete payoff",
      };
    }
    if (profile.full_payoff_latest_ratio !== null) {
      pullPayoffEarlier(blueprint, targetIndex, profile.full_payoff_latest_ratio);
    }
  }

  return blueprint;
}

function payoffCandidateRefs(selectsInput: unknown): Set<string> {
  const refs = new Set<string>();
  for (const candidate of candidateRows(selectsInput)) {
    if (stringValue(candidate.story_role) !== "payoff") continue;
    for (const ref of candidateRefs(candidate)) refs.add(ref);
  }
  return refs;
}

function systemFacingLabels(blueprint: EditBlueprint): string[] {
  return blueprint.beats
    .filter((beat) => !beat.viewer_label || SYSTEM_LABEL_PATTERN.test(beat.viewer_label))
    .map((beat) => `${beat.id}:${beat.viewer_label ?? beat.label}`)
    .filter((entry) => {
      const label = entry.slice(entry.indexOf(":") + 1);
      return SYSTEM_LABEL_PATTERN.test(label);
    });
}

function hasVisualRefreshPlan(blueprint: EditBlueprint): boolean {
  const activeSkills = blueprint.active_editing_skills ?? [];
  if (activeSkills.some((skill) => VISUAL_REFRESH_PATTERN.test(skill))) return true;
  const explicitGoals = blueprint.sequence_goals.filter((goal) => VISUAL_REFRESH_PATTERN.test(goal));
  if (explicitGoals.length > 0) return true;
  const beatsWithRefresh = blueprint.beats.filter((beat) =>
    VISUAL_REFRESH_PATTERN.test([beat.viewer_label, beat.purpose, beat.notes, ...(beat.skill_hints ?? [])].filter(Boolean).join(" "))
  );
  return beatsWithRefresh.length >= 2;
}

function isLowMotionSource(selectsInput: unknown): boolean {
  const summary = recordValue(recordValue(selectsInput).editorial_summary);
  return stringValue(summary.dominant_visual_mode) === "talking_head"
    || stringValue(summary.motion_profile) === "low";
}

/** Deterministic post-generation audit used by both split and unified editorial routes. */
export function auditShortFormRetention(
  briefInput: unknown,
  blueprint: EditBlueprint,
  selectsInput?: unknown,
): ShortFormRetentionIssue[] {
  const profile = deriveShortFormRetentionProfile(briefInput);
  if (!profile.enabled) return [];

  const issues: ShortFormRetentionIssue[] = [];
  const firstBeat = blueprint.beats[0];
  if (!firstBeat || firstBeat.story_role !== "hook") {
    issues.push({
      code: "cold_open_missing",
      message: "short-social structure has no explicit opening hook beat",
    });
  }

  if (profile.mode === "aggressive" && firstBeat) {
    if (profile.cold_open_max_frames !== null && firstBeat.target_duration_frames > profile.cold_open_max_frames) {
      issues.push({
        code: "cold_open_too_long",
        message: `aggressive cold open is ${firstBeat.target_duration_frames} frames; keep it within ${profile.cold_open_max_frames} frames at 24fps`,
      });
    }
    if (blueprint.story_arc?.strategy !== "peak_first" || blueprint.story_arc.allow_time_reorder !== true) {
      issues.push({
        code: "peak_first_missing",
        message: "aggressive short-social structure must explicitly use peak_first with time reordering",
      });
    }

    const payoffRefs = payoffCandidateRefs(selectsInput);
    if (payoffRefs.size === 0 && selectsInput !== undefined) {
      issues.push({
        code: "payoff_candidate_missing",
        message: "aggressive short-social selects contain no candidate with story_role=payoff",
      });
    } else if (payoffRefs.size > 0 && profile.full_payoff_latest_ratio !== null) {
      let elapsedFrames = 0;
      const totalFrames = blueprint.beats.reduce((sum, beat) => sum + beat.target_duration_frames, 0);
      let payoffStartFrames: number | null = null;
      for (const [index, beat] of blueprint.beats.entries()) {
        const refs = [
          beat.candidate_plan?.primary_candidate_ref,
          ...(beat.candidate_plan?.fallback_candidate_refs ?? []),
        ].filter((ref): ref is string => Boolean(ref));
        // Beat zero is the teaser by contract; find the later complete payoff.
        if (index > 0 && refs.some((ref) => payoffRefs.has(ref))) {
          payoffStartFrames = elapsedFrames;
          break;
        }
        elapsedFrames += beat.target_duration_frames;
      }
      if (payoffStartFrames === null) {
        issues.push({
          code: "payoff_candidate_missing",
          message: "the selected payoff candidate is not assigned to any blueprint beat",
        });
      } else if (totalFrames > 0 && payoffStartFrames / totalFrames > profile.full_payoff_latest_ratio) {
        issues.push({
          code: "payoff_too_late",
          message: `complete payoff begins at ${Math.round((payoffStartFrames / totalFrames) * 100)}% of runtime; target ${Math.round(profile.full_payoff_latest_ratio * 100)}% or earlier`,
        });
      }
    }
  }

  const exposedLabels = systemFacingLabels(blueprint);
  if (exposedLabels.length > 0) {
    issues.push({
      code: "system_label_exposed",
      message: `viewer-facing labels still expose editor vocabulary: ${exposedLabels.join(", ")}`,
    });
  }

  if ((profile.target_duration_sec ?? 0) >= 20 && isLowMotionSource(selectsInput) && !hasVisualRefreshPlan(blueprint)) {
    issues.push({
      code: "visual_refresh_plan_missing",
      message: "low-motion short-social blueprint has no explicit semantic visual-refresh plan",
    });
  }

  return issues;
}
