import { ASS_HEAVY_VIDEO_FONT } from "../../editor/shared/font-contract.js";
import {
  hasCaptionStylePreset,
  resolveCaptionStylePreset,
  type CaptionStylePreset,
} from "../../editor/shared/caption-style-tokens.js";
import { readProjectCaptionStylingClass } from "../../editor/shared/project-caption-settings.js";
import type { AssSubtitleStyleOptions } from "./promo-finisher.js";

const SOCIAL_REVIEW_STYLING_CLASSES = new Set([
  "sns-vertical",
  "sns-vertical-outline",
  "single-layer-speaker-separated-safe-area-ja",
  "single-layer-speaker-separated-bold-outline-safe-area-ja",
]);

export function isSocialReviewCaptionStyle(stylingClass?: string): boolean {
  return Boolean(stylingClass && SOCIAL_REVIEW_STYLING_CLASSES.has(stylingClass));
}

export function socialReviewCaptionStyle(
  width: number,
  height: number,
): AssSubtitleStyleOptions {
  return {
    fontName: ASS_HEAVY_VIDEO_FONT.family,
    playResX: width,
    playResY: height,
    fontSize: width === 1080 ? 64 : Math.round(width * 0.0593),
    marginV: height === 1920 ? 300 : Math.round(height * 0.15625),
    borderStyle: 3,
    outline: width === 1080 ? 12 : Math.max(8, Math.round(width * 0.0111)),
    backColor: "&H500B2434",
  };
}

export function captionPresetToAssStyle(
  preset: CaptionStylePreset,
  width: number,
  height: number,
): AssSubtitleStyleOptions {
  const scale = height / 1080;
  return {
    fontName: preset.assFontFamily ?? preset.fontFamily,
    playResX: width,
    playResY: height,
    fontSize: Math.round(preset.fontSizePx1080 * scale),
    marginV: Math.round(preset.marginV1080 * scale),
    borderStyle: 1,
    outline: Math.round(preset.outlinePx1080 * scale * 10) / 10,
    bold: preset.assSynthesizeBold ?? preset.fontWeight >= 700,
  };
}

/**
 * Resolve ASS typography for the social-review renderer.
 *
 * An explicit registered project style wins, including clean-lower-third.
 * Explicit SNS styles keep the current social-review values. Missing or
 * unknown classes keep that same social-review default so existing callers
 * stay backward compatible. Caption-plan presentation metadata is not an
 * input here; callers must pass the blueprint styling_class only.
 */
export function resolveSocialReviewCaptionStyle(
  stylingClass: string | undefined,
  width: number,
  height: number,
): AssSubtitleStyleOptions {
  if (
    stylingClass
    && hasCaptionStylePreset(stylingClass)
    && !isSocialReviewCaptionStyle(stylingClass)
  ) {
    return captionPresetToAssStyle(resolveCaptionStylePreset(stylingClass), width, height);
  }
  return socialReviewCaptionStyle(width, height);
}

export function resolveProjectSocialReviewCaptionStyle(
  projectDir: string,
  width: number,
  height: number,
): AssSubtitleStyleOptions {
  return resolveSocialReviewCaptionStyle(
    readProjectCaptionStylingClass(projectDir),
    width,
    height,
  );
}
