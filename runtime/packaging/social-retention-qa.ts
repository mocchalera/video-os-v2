import type { TimelineIR } from "../compiler/types.js";
import { normalizeOverlayClipContent } from "../content/normalize.js";
import { deriveShortFormRetentionProfile } from "../editorial/short-form-retention.js";
import type { QaCheckResult } from "./qa.js";

const MAX_VISUAL_REFRESH_GAP_SEC = 14;
const CTA_REQUIRED_PATTERN = /(?:\bcta\b|call[\s_-]*to[\s_-]*action|申し?込み|申込|問い合わせ|資料請求|無料相談|体験|登録|プロフィール|詳しく)/i;

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
    return typeof value === "string" ? [...value].length : null;
  }
  const style = overlayStyle(clip);
  if (!/(?:^|\.)(?:hook-title|title-card)$/i.test(style)) return null;
  const overlay = recordValue(clip.metadata?.overlay);
  return typeof overlay.text === "string" ? [...overlay.text].length : null;
}

/** Render-level guard for the retention devices promised during planning. */
export function checkSocialRetentionFinishing(
  timeline: TimelineIR,
  brief: unknown,
): QaCheckResult[] {
  const profile = deriveShortFormRetentionProfile(brief);
  if (!profile.enabled) return [];
  const fps = timeline.sequence.fps_num / timeline.sequence.fps_den;
  const overlayTracks = (timeline.tracks as TimelineIR["tracks"] & {
    overlay?: TimelineIR["tracks"]["video"];
  }).overlay ?? [];
  const hookFrames = overlayTracks.flatMap((track) =>
    track.clips.filter(isHookOverlay).map((clip) => clip.timeline_in_frame)
  );
  const hookLatestFrame = Math.round(2 * fps);
  const hookPassed = profile.mode !== "aggressive"
    || hookFrames.some((frame) => frame <= hookLatestFrame);

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
  const refreshRequired = durationFrames / fps >= 20;
  const refreshPassed = !refreshRequired || maxGapSec <= MAX_VISUAL_REFRESH_GAP_SEC;

  const titleLengths = overlayTracks.flatMap((track) => track.clips.map(titleCopyLength)).filter((value): value is number => value !== null);
  const titleCopyPassed = titleLengths.every((length) => length <= 80);

  const ctaRequired = CTA_REQUIRED_PATTERN.test(briefText(brief));
  const ctaClips = overlayTracks.flatMap((track) => track.clips.filter(isCtaOverlay));
  const ctaThresholdFrame = Math.floor(durationFrames * 0.65);
  const ctaMinimumFrames = Math.round(fps * 2);
  const ctaPassed = !ctaRequired || ctaClips.some((clip) =>
    clip.timeline_in_frame >= ctaThresholdFrame
    && clip.timeline_duration_frames >= ctaMinimumFrames
  );

  const policy = audioPolicy(brief);
  const musicPresent = timeline.tracks.audio.some((track) =>
    track.clips.some((clip) => /^(?:bgm|music)$/i.test(clip.role ?? ""))
  );
  const audioPolicyPassed = policy === "original_only"
    || ((policy === "ducking" || policy === "bgm_only") && musicPresent);

  return [
    {
      name: "social_hook_treatment_valid",
      passed: hookPassed,
      details: hookPassed
        ? profile.mode === "aggressive"
          ? "Aggressive social edit has a registered hook-title within 2.0s"
          : `Hook-title not required for retention mode=${profile.mode}`
        : "Aggressive social edit requires a registered hook-title within the first 2.0s",
    },
    {
      name: "social_visual_refresh_valid",
      passed: refreshPassed,
      details: refreshPassed
        ? `Maximum meaningful visual-refresh gap ${maxGapSec.toFixed(2)}s (limit ${MAX_VISUAL_REFRESH_GAP_SEC}s)`
        : `Maximum meaningful visual-refresh gap ${maxGapSec.toFixed(2)}s exceeds ${MAX_VISUAL_REFRESH_GAP_SEC}s; add a real cut, registered punch-in clip, or emphasis overlay at a semantic turn`,
    },
    {
      name: "social_title_copy_fit_valid",
      passed: titleCopyPassed,
      details: titleCopyPassed
        ? "Social hook/title copy fits the 80-character renderer contract"
        : `Social hook/title copy is too long (${Math.max(...titleLengths)} characters); shorten it or use a non-hook treatment`,
    },
    {
      name: "social_cta_treatment_valid",
      passed: ctaPassed,
      details: ctaPassed
        ? ctaRequired
          ? "Required CTA uses the registered full-frame CTA treatment in the final 35% for at least 2.0s"
          : "No explicit CTA requirement in the brief"
        : "Brief requires a CTA; add a registered cta-card in the final 35% and hold it for at least 2.0s",
    },
    {
      name: "social_audio_policy_valid",
      passed: audioPolicyPassed,
      details: audioPolicyPassed
        ? policy === "original_only"
          ? "Short-form brief explicitly selects original audio only"
          : `Short-form brief selects ${policy} and the timeline contains a music track`
        : policy.length === 0
          ? "Short-form brief must explicitly choose audio_policy: ducking, bgm_only, or original_only"
          : `Short-form brief selects ${policy}, but the timeline contains no bgm/music clip`,
    },
  ];
}
