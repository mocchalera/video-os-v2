import * as fs from "node:fs";
import * as path from "node:path";
import type { TimelineIR } from "../compiler/types.js";
import { normalizeOverlayClipContent } from "../content/normalize.js";
import { deriveShortFormRetentionProfile, evaluateRetentionPolicy, loadDefaultRetentionPolicy, loadRetentionPolicy, retentionPolicyContentHash, type RetentionEvidenceInput, type RetentionPolicyDocument } from "../editorial/short-form-retention.js";
import { measureDisplayUnits } from "../caption/line-breaker.js";
import type { QaCheckResult } from "./qa.js";

const CTA_REQUIRED_PATTERN = /(?:\bcta\b|call[\s_-]*to[\s_-]*action|申し?込み|申込|問い合わせ|資料請求|無料相談|体験|登録|プロフィール|詳しく)/i;

function resolveSocialRetentionQaPolicy(policy?: RetentionPolicyDocument | null): RetentionPolicyDocument | null | undefined {
  if (policy === null) return null;
  if (policy) return policy;
  const defaultPath = path.join(process.cwd(), "delivery_profiles/retention/legacy-social-v1.json");
  return fs.existsSync(defaultPath) ? loadRetentionPolicy(defaultPath) : undefined;
}

function isContainedPath(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** Resolve the exact retention policy provenance emitted by the compiler. */
export function resolveCompilerRetentionPolicy(projectDir: string, timeline: TimelineIR): RetentionPolicyDocument | null {
  const provenance = timeline.provenance.retention_policy;
  if (!provenance) return null;
  const evidence = recordValue(recordValue(timeline.metadata).retention_evidence);
  if (evidence.producer !== "compiler" || evidence.policy_ref !== provenance.policy_ref || evidence.policy_hash !== provenance.policy_hash) {
    throw new Error("compiler retention policy provenance and retention evidence producer do not match");
  }
  const policyPath = path.resolve(projectDir, provenance.policy_ref);
  if (!isContainedPath(projectDir, policyPath) || !fs.existsSync(policyPath)) {
    throw new Error(`compiler retention policy artifact is missing or outside the project: ${provenance.policy_ref}`);
  }
  const policy = loadRetentionPolicy(policyPath);
  if (policy.policy_id !== provenance.policy_id || retentionPolicyContentHash(policy) !== provenance.policy_hash) {
    throw new Error(`compiler retention policy hash is stale: ${provenance.policy_ref}`);
  }
  return policy;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function briefText(brief: unknown): string {
  const value = recordValue(brief);
  const message = recordValue(value.message);
  const mustHave = Array.isArray(value.must_have)
    ? value.must_have.filter((item): item is string => typeof item === "string")
    : [];
  return [message.primary, ...mustHave].filter((item): item is string => typeof item === "string").join("\n");
}

function audioPolicy(brief: unknown): string {
  const value = recordValue(brief).audio_policy;
  return typeof value === "string" ? value : "";
}

function canonicalRetentionEvidence(timeline: TimelineIR, brief: unknown, requestedMode: RetentionEvidenceInput["requested_mode"], measured: { refreshPassed: boolean; titleCopyPassed: boolean; audioPolicyPassed: boolean }): RetentionEvidenceInput {
  const clips = timeline.tracks.video.flatMap((track) => track.clips);
  const captionClips = (timeline.tracks.caption ?? []).flatMap((track) => track.clips);
  const truthGuards = recordValue(recordValue(brief).truth_guards);
  const evidence = recordValue(recordValue(timeline.metadata).retention_evidence);
  const compilerEvidence = evidence.producer === "compiler" ? evidence : {};
  const boundaries = recordValue(compilerEvidence.audio_boundaries);
  const tempo = recordValue(compilerEvidence.tempo);
  const accessibility = recordValue(compilerEvidence.accessibility);
  const sourceEvidence = clips.length > 0 && clips.every((clip) => Boolean(clip.asset_id && clip.segment_id && clip.src_out_us > clip.src_in_us));
  const payoff = clips.some((clip) => /(?:payoff|result|resolution|closing|reaction|結末|結果|反応)/i.test(`${clip.role ?? ""} ${clip.motivation ?? ""} ${clip.beat_id ?? ""}`));
  return {
    requested_mode: requestedMode,
    promise: { present: briefText(brief).trim().length > 0, truthful: !Boolean(truthGuards.false_spoiler || truthGuards.clickbait || truthGuards.fabricated_evidence) },
    source_evidence: { present: sourceEvidence, attributable: sourceEvidence },
    payoff: { present: payoff, proportional: payoff },
    readability: captionClips.length > 0 ? { pass: measured.titleCopyPassed } : undefined,
    audibility: { pass: measured.audioPolicyPassed },
    accessibility: typeof accessibility.pass === "boolean" ? { pass: accessibility.pass } : undefined,
    policy: { pass: !Boolean(truthGuards.false_spoiler || truthGuards.clickbait || truthGuards.fabricated_evidence), clickbait: Boolean(truthGuards.clickbait), false_spoiler: Boolean(truthGuards.false_spoiler), fabricated_evidence: Boolean(truthGuards.fabricated_evidence) },
    fatigue: { pass: measured.refreshPassed },
    audio_boundaries: Object.keys(boundaries).length > 0 ? {
      phoneme_safe: boundaries.phoneme_safe === true,
      word_onset_safe: boundaries.word_onset_safe === true,
      conjunction_safe: boundaries.conjunction_safe === true,
      causal_bridge_safe: boundaries.causal_bridge_safe === true,
      offset_map_sync: boundaries.offset_map_sync === true,
    } : undefined,
    tempo: Object.keys(tempo).length > 0 ? {
      event_envelope: tempo.event_envelope === true,
      meaningful_visual_refresh: tempo.meaningful_visual_refresh === true,
      pause_or_silence_allowed: tempo.pause_or_silence_allowed === true,
      sfx_per_cut: tempo.sfx_per_cut === true,
    } : undefined,
  };
}

function overlayStyle(clip: TimelineIR["tracks"]["video"][number]["clips"][number]): string {
  const overlay = clip.metadata?.overlay;
  return overlay && typeof overlay === "object" && typeof (overlay as Record<string, unknown>).styling_class === "string"
    ? String((overlay as Record<string, unknown>).styling_class)
    : "";
}

function isHookOverlay(clip: TimelineIR["tracks"]["video"][number]["clips"][number]): boolean {
  const normalized = normalizeOverlayClipContent(clip);
  return normalized.element?.template_ref === "vos:content.hook-title/v1"
    || /(?:^|\.)hook-title$/i.test(overlayStyle(clip));
}

function isEmphasisOverlay(clip: TimelineIR["tracks"]["video"][number]["clips"][number]): boolean {
  const normalized = normalizeOverlayClipContent(clip);
  return normalized.element?.template_ref === "vos:content.emphasis-word/v1"
    || /(?:^|\.)emphasis-word$/i.test(overlayStyle(clip));
}

function isCtaOverlay(clip: TimelineIR["tracks"]["video"][number]["clips"][number]): boolean {
  const normalized = normalizeOverlayClipContent(clip);
  return normalized.element?.template_ref === "vos:content.cta-card/v1"
    || /(?:^|\.)cta-card$/i.test(overlayStyle(clip));
}

function titleCopyLength(clip: TimelineIR["tracks"]["video"][number]["clips"][number]): number | null {
  const normalized = normalizeOverlayClipContent(clip);
  const templateRef = normalized.element?.template_ref;
  if (templateRef === "vos:content.hook-title/v1" || templateRef === "vos:content.title-card/v1") {
    const value = normalized.element?.props.title;
    return typeof value === "string" ? measureDisplayUnits(value) : null;
  }
  const style = overlayStyle(clip);
  if (!/(?:^|\.)(?:hook-title|title-card)$/i.test(style)) return null;
  const overlay = recordValue(clip.metadata?.overlay);
  return typeof overlay.text === "string" ? measureDisplayUnits(overlay.text) : null;
}

/** Render-level guard for the retention devices promised during planning. */
export function checkSocialRetentionFinishing(
  timeline: TimelineIR,
  brief: unknown,
  retentionPolicy?: RetentionPolicyDocument | null,
): QaCheckResult[] {
  const retentionContract = resolveSocialRetentionQaPolicy(retentionPolicy);
  if (retentionContract === null) {
    return [{
      name: "social_retention_policy_provenance",
      passed: false,
      details: "compiler retention policy provenance is unavailable; retention evidence remains unknown",
    }];
  }
  const profile = deriveShortFormRetentionProfile(brief, { policy: retentionContract ?? loadDefaultRetentionPolicy() });
  if (!profile.enabled) return [];
  const qa = retentionContract?.qa;
  const fps = timeline.sequence.fps_num / timeline.sequence.fps_den;
  const overlayTracks = (timeline.tracks as TimelineIR["tracks"] & {
    overlay?: TimelineIR["tracks"]["video"];
  }).overlay ?? [];
  const hookFrames = overlayTracks.flatMap((track) =>
    track.clips.filter(isHookOverlay).map((clip) => clip.timeline_in_frame)
  );
  const hookLatestFrame = qa?.hook_max_start_sec === null || qa?.hook_max_start_sec === undefined
    ? null
    : Math.round(qa.hook_max_start_sec * fps);
  const hookPassed = profile.mode !== "aggressive"
    || (hookLatestFrame !== null && hookFrames.some((frame) => frame <= hookLatestFrame));

  const durationFrames = timeline.tracks.video.flatMap((track) => track.clips)
    .reduce((max, clip) => Math.max(max, clip.timeline_in_frame + clip.timeline_duration_frames), 0);
  const eventFrames = new Set<number>([0, durationFrames]);
  for (const track of timeline.tracks.video) {
    for (const clip of track.clips) eventFrames.add(clip.timeline_in_frame);
  }
  for (const track of overlayTracks) {
    for (const clip of track.clips) {
      if (isHookOverlay(clip) || isEmphasisOverlay(clip)) eventFrames.add(clip.timeline_in_frame);
    }
  }
  const sorted = [...eventFrames].sort((a, b) => a - b);
  let maxGapFrames = 0;
  for (let index = 1; index < sorted.length; index += 1) {
    maxGapFrames = Math.max(maxGapFrames, sorted[index] - sorted[index - 1]);
  }
  const maxGapSec = fps > 0 ? maxGapFrames / fps : Number.POSITIVE_INFINITY;
  const refreshLimit = qa?.visual_refresh_max_gap_sec;
  const refreshRequired = refreshLimit !== null && refreshLimit !== undefined && durationFrames / fps >= refreshLimit;
  const refreshPassed = !refreshRequired || (refreshLimit !== null && refreshLimit !== undefined && maxGapSec <= refreshLimit);

  const titleLengths = overlayTracks.flatMap((track) => track.clips.map(titleCopyLength)).filter((value): value is number => value !== null);
  const titleLimit = qa?.title_max_display_units;
  const titleCopyPassed = titleLimit !== null && titleLimit !== undefined && titleLengths.every((length) => length <= titleLimit);

  const ctaRequired = CTA_REQUIRED_PATTERN.test(briefText(brief));
  const ctaClips = overlayTracks.flatMap((track) => track.clips.filter(isCtaOverlay));
  const ctaThresholdFrame = qa?.cta_latest_start_ratio === null || qa?.cta_latest_start_ratio === undefined
    ? null
    : Math.floor(durationFrames * qa.cta_latest_start_ratio);
  const ctaMinimumFrames = qa?.cta_min_hold_sec === null || qa?.cta_min_hold_sec === undefined
    ? null
    : Math.round(fps * qa.cta_min_hold_sec);
  const ctaPassed = !ctaRequired || (ctaThresholdFrame !== null && ctaMinimumFrames !== null && ctaClips.some((clip) =>
    clip.timeline_in_frame >= ctaThresholdFrame
    && clip.timeline_duration_frames >= ctaMinimumFrames
  ));

  const selectedAudioPolicy = audioPolicy(brief);
  const musicPresent = timeline.tracks.audio.some((track) =>
    track.clips.some((clip) => /^(?:bgm|music)$/i.test(clip.role ?? ""))
  );
  const audioPolicyPassed = selectedAudioPolicy === "original_only"
    || ((selectedAudioPolicy === "ducking" || selectedAudioPolicy === "bgm_only") && musicPresent);
  const resolvedRetentionPolicy = retentionContract ?? loadDefaultRetentionPolicy();
  const retentionReceipt = resolvedRetentionPolicy
    ? evaluateRetentionPolicy(canonicalRetentionEvidence(timeline, brief, profile.mode, { refreshPassed, titleCopyPassed, audioPolicyPassed }), resolvedRetentionPolicy)
    : undefined;

  return [
    {
      name: "social_hook_treatment_valid",
      passed: hookPassed,
      details: hookPassed
        ? profile.mode === "aggressive"
          ? `Aggressive social edit has a registered hook-title within ${qa?.hook_max_start_sec ?? "the registered"}s`
          : `Hook-title not required for retention mode=${profile.mode}`
        : "Aggressive social edit requires a registered hook-title within the policy window",
    },
    {
      name: "social_visual_refresh_valid",
      passed: refreshPassed,
      details: refreshPassed
        ? `Maximum meaningful visual-refresh gap ${maxGapSec.toFixed(2)}s (registered policy limit ${refreshLimit ?? "unknown"}s)`
        : `Maximum meaningful visual-refresh gap ${maxGapSec.toFixed(2)}s is unavailable or exceeds the registered policy; add a real cut, registered punch-in clip, or emphasis overlay at a semantic turn`,
    },
    {
      name: "social_title_copy_fit_valid",
      passed: titleCopyPassed,
      details: titleCopyPassed
        ? `Social hook/title copy fits the registered ${titleLimit}-unit renderer contract`
        : `Social hook/title copy is too long (${titleLengths.length > 0 ? Math.max(...titleLengths) : "unknown"} display units); shorten it or use a non-hook treatment`,
    },
    {
      name: "social_cta_treatment_valid",
      passed: ctaPassed,
      details: ctaPassed
        ? ctaRequired
          ? "Required CTA uses the registered CTA treatment within the policy window and hold duration"
          : "No explicit CTA requirement in the brief"
        : "Brief requires a CTA; add a registered cta-card within the policy window and hold it for the registered duration",
    },
    {
      name: "social_audio_policy_valid",
      passed: audioPolicyPassed,
      details: audioPolicyPassed
        ? selectedAudioPolicy === "original_only"
          ? "Short-form brief explicitly selects original audio only"
          : `Short-form brief selects ${selectedAudioPolicy} and the timeline contains a music track`
        : selectedAudioPolicy.length === 0
          ? "Short-form brief must explicitly choose audio_policy: ducking, bgm_only, or original_only"
          : `Short-form brief selects ${selectedAudioPolicy}, but the timeline contains no bgm/music clip`,
    },
    ...(retentionReceipt ? [{
      name: "social_retention_truth_bound",
      passed: retentionReceipt.status !== "blocked",
      details: `retention receipt=${retentionReceipt.receipt_hash} input=${retentionReceipt.input_hash} policy=${retentionReceipt.policy_hash} status=${retentionReceipt.status}`,
    }] : []),
  ];
}
