import { deriveShortFormRetentionProfile } from "../editorial/short-form-retention.js";
import type { TextOverlayInput } from "./overlay.js";

type BriefLike = {
  project?: { title?: unknown };
};

const TITLE_CARD_STYLES = new Set([
  undefined,
  "title-card",
  "vos:overlay.title-card",
  "hook-title",
  "vos:overlay.hook-title",
]);

function usableProjectTitle(brief: BriefLike): string | null {
  const value = brief.project?.title;
  if (typeof value !== "string") return null;
  const title = value.trim();
  return title.length > 0 && [...title].length <= 40 ? title : null;
}

/**
 * Promote or create one explicit cold-open overlay for aggressive social work.
 * Non-social, long-form, balanced, and credibility-first projects are returned
 * byte-for-byte unchanged.
 */
export function planSocialHookOverlay(input: {
  brief: unknown;
  overlays?: TextOverlayInput[];
  fps: number;
  width: number;
  height: number;
}): TextOverlayInput[] {
  const overlays = input.overlays?.map((overlay) => ({ ...overlay })) ?? [];
  const profile = deriveShortFormRetentionProfile(input.brief);
  if (!profile.enabled || profile.mode !== "aggressive") return overlays;

  const latestOpeningFrame = Math.round(input.fps * 2);
  const openingIndex = overlays.findIndex((overlay) =>
    overlay.timeline_in_frame <= latestOpeningFrame
    && TITLE_CARD_STYLES.has(overlay.styling_class)
  );
  if (openingIndex >= 0) {
    overlays[openingIndex] = {
      ...overlays[openingIndex],
      styling_class: "vos:overlay.hook-title",
    };
    return overlays;
  }

  const title = usableProjectTitle(input.brief as BriefLike);
  if (!title) return overlays;
  overlays.unshift({
    overlay_id: "OVL_SOCIAL_HOOK_TITLE",
    timeline_in_frame: 0,
    timeline_duration_frames: Math.max(1, Math.round(input.fps * 1.6)),
    text: title,
    styling_class: "vos:overlay.hook-title",
    writing_mode: "horizontal_tb",
    anchor: "top_left",
    safe_area: {
      top: Math.round(input.height * 0.08),
      right: Math.round(input.width * 0.06),
      bottom: Math.round(input.height * 0.1),
      left: Math.round(input.width * 0.06),
    },
  });
  return overlays;
}
