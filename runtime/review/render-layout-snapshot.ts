import {
  resolveCaptionStylePreset,
  type CaptionStylePreset,
} from "../../editor/shared/caption-style-tokens.js";
import type { CaptionApproval } from "../caption/approval.js";
import {
  inspectCaptionFontContract,
  type CaptionFontContract,
} from "../caption/font-contract.js";
import { resolveContentTemplate } from "../content/template-registry.js";
import { findMissingFontGlyphs } from "../fonts/font-glyph-coverage.js";
import { remotionDesignTokens } from "../render/remotion/styles/design-tokens.js";
import {
  RENDER_LAYOUT_SNAPSHOT_VERSION,
  type RenderLayoutBounds,
  type RenderLayoutLayer,
  type RenderLayoutSafeArea,
  type RenderLayoutSnapshot,
} from "./deterministic-layout-qa.js";

interface LayoutTimelineClip {
  clip_id?: string;
  timeline_in_frame?: number;
  timeline_duration_frames?: number;
  media_kind?: string;
  content_element?: unknown;
  metadata?: unknown;
}

export interface LayoutTimeline {
  sequence?: {
    width?: number;
    height?: number;
    fps_num?: number;
    fps_den?: number;
  };
  tracks?: {
    video?: Array<{ clips?: LayoutTimelineClip[] }>;
    overlay?: Array<{ clips?: LayoutTimelineClip[] }>;
  };
}

export interface BuildRenderLayoutSnapshotOptions {
  inspectCaptionFontContractImpl?: typeof inspectCaptionFontContract;
  findMissingFontGlyphsImpl?: typeof findMissingFontGlyphs;
}

/**
 * Project approved captions and canonical overlay geometry into a stable
 * renderer-layout snapshot. The snapshot contains no source frames or copy,
 * only frame ranges, measured layout envelopes, and font/glyph evidence.
 */
export function buildRenderLayoutSnapshot(
  timeline: LayoutTimeline,
  captionApproval?: CaptionApproval,
  options: BuildRenderLayoutSnapshotOptions = {},
): RenderLayoutSnapshot {
  const frame = sequenceFrame(timeline);
  const safeArea = defaultSafeArea(frame.width, frame.height);
  const inspectFont =
    options.inspectCaptionFontContractImpl ?? inspectCaptionFontContract;
  const inspectGlyphs =
    options.findMissingFontGlyphsImpl ?? findMissingFontGlyphs;
  const captionPolicy = captionApproval?.caption_policy;
  const fontContract = captionPolicy?.source === "none" || !captionPolicy
    ? undefined
    : inspectFont(captionPolicy.styling_class);
  const captions = captionApproval?.speech_captions ?? [];
  const missingGlyphs = glyphCoverageByCaption(
    captions,
    fontContract,
    inspectGlyphs,
  );
  const layers: RenderLayoutLayer[] = captions.map((caption) => {
    const style = resolveCaptionStylePreset(
      caption.styling_class || captionPolicy?.styling_class,
    );
    return {
      layer_id: caption.caption_id,
      semantic_role: "speech_caption",
      source: "ffmpeg-libass",
      start_frame: caption.timeline_in_frame,
      end_frame:
        caption.timeline_in_frame + caption.timeline_duration_frames,
      bounds: captionEnvelope(caption.text, style, frame.width, frame.height),
      font: {
        status: fontContract?.status === "ready" &&
            fontContract.fallback_used === false
          ? "verified"
          : fontContract?.status === "blocked"
          ? "fallback"
          : "missing",
        requested_family: style.assFontFamily ?? style.fontFamily,
        ...(fontContract?.selected_family
          ? { resolved_family: fontContract.selected_family }
          : {}),
        missing_glyphs: missingGlyphs.get(caption.caption_id) ?? [],
      },
    };
  });

  const captionTexts = captions.map((caption) => ({
    text: normalizedVisibleText(caption.text),
    start: caption.timeline_in_frame,
    end: caption.timeline_in_frame + caption.timeline_duration_frames,
  }));
  for (const clip of timeline.tracks?.overlay?.flatMap((track) =>
    track.clips ?? []
  ) ?? []) {
    const layer = overlayLayer(clip, frame.width, frame.height, safeArea);
    if (!layer) continue;
    const text = overlayText(clip);
    if (
      text &&
      captionTexts.some((caption) =>
        caption.text.length >= 4 &&
        caption.text === normalizedVisibleText(text) &&
        rangesOverlap(
          caption.start,
          caption.end,
          layer.start_frame,
          layer.end_frame,
        )
      )
    ) {
      layers.push({
        ...layer,
        semantic_role: "speech_caption",
        font: rendererFontEvidence(fontContract),
      });
    } else {
      layers.push(layer);
    }
  }

  const totalFrames = timelineDurationFrames(timeline, layers);
  const terminalCta = layers.find((layer) =>
    layer.semantic_role === "cta" && layer.end_frame === totalFrames
  );
  const terminalVideo = timeline.tracks?.video
    ?.flatMap((track) => track.clips ?? [])
    .find((clip) =>
      validFrameRange(clip) &&
      clip.timeline_in_frame! < totalFrames &&
      clip.timeline_in_frame! + clip.timeline_duration_frames! === totalFrames
    );
  const finalFrameState = terminalCta
    ? "meaningful_end_card" as const
    : totalFrames === 0 && layers.length === 0
    ? "not_applicable" as const
    : terminalVideo?.media_kind === "image"
    ? "intentional_still" as const
    : terminalVideo
    ? "moving_source" as const
    : "unknown" as const;

  return {
    version: RENDER_LAYOUT_SNAPSHOT_VERSION,
    frame: {
      ...frame,
      total_frames: totalFrames,
      safe_area: safeArea,
    },
    layers,
    ending: {
      final_frame_state: finalFrameState,
      ...(terminalCta ? { end_card_layer_id: terminalCta.layer_id } : {}),
    },
  };
}

function sequenceFrame(timeline: LayoutTimeline): {
  width: number;
  height: number;
  fps_num: number;
  fps_den: number;
} {
  const width = timeline.sequence?.width;
  const height = timeline.sequence?.height;
  const fpsNum = timeline.sequence?.fps_num;
  const fpsDen = timeline.sequence?.fps_den;
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    !Number.isInteger(fpsNum) ||
    !Number.isInteger(fpsDen) ||
    width! <= 0 ||
    height! <= 0 ||
    fpsNum! <= 0 ||
    fpsDen! <= 0
  ) {
    throw new Error("render layout snapshot requires valid sequence geometry");
  }
  return {
    width: width!,
    height: height!,
    fps_num: fpsNum!,
    fps_den: fpsDen!,
  };
}

function defaultSafeArea(width: number, height: number): RenderLayoutSafeArea {
  const ratio = width / height;
  const source = ratio < 0.7
    ? remotionDesignTokens.safeAreas["9:16"]
    : ratio < 0.9
    ? remotionDesignTokens.safeAreas["4:5"]
    : ratio < 1.2
    ? remotionDesignTokens.safeAreas["1:1"]
    : remotionDesignTokens.safeAreas["16:9"];
  const scale = height / 1920;
  return {
    top: Math.round(source.top * scale),
    right: Math.round(source.right * scale),
    bottom: Math.round(source.bottom * scale),
    left: Math.round(source.left * scale),
  };
}

function glyphCoverageByCaption(
  captions: CaptionApproval["speech_captions"],
  font: CaptionFontContract | undefined,
  inspectGlyphs: typeof findMissingFontGlyphs,
): Map<string, string[]> {
  const output = new Map<string, string[]>();
  if (!font?.selected_asset?.path || font.status !== "ready") return output;
  for (const caption of captions) {
    output.set(
      caption.caption_id,
      inspectGlyphs(font.selected_asset.path, [caption.text]),
    );
  }
  return output;
}

function rendererFontEvidence(
  font: CaptionFontContract | undefined,
): NonNullable<RenderLayoutLayer["font"]> {
  return {
    status: font?.status === "ready" && font.fallback_used === false
      ? "verified"
      : font?.status === "blocked"
      ? "fallback"
      : "missing",
    requested_family: font?.family ?? "unknown",
    ...(font?.selected_family ? { resolved_family: font.selected_family } : {}),
    missing_glyphs: [],
  };
}

function captionEnvelope(
  rawText: string,
  style: CaptionStylePreset,
  frameWidth: number,
  frameHeight: number,
): RenderLayoutBounds {
  const scale = frameHeight / 1080;
  const speaker = style.speakerSeparation;
  const separatorIndex = speaker
    ? rawText.indexOf(speaker.separator)
    : -1;
  const label = separatorIndex >= 0
    ? rawText.slice(0, separatorIndex).trim()
    : "";
  const text = separatorIndex >= 0
    ? rawText.slice(separatorIndex + speaker!.separator.length).trim()
    : rawText;
  const isOffscreen = Boolean(
    speaker && separatorIndex >= 0 && speaker.offscreenLabels.includes(label),
  );
  const alignment = speaker && separatorIndex >= 0
    ? isOffscreen
      ? speaker.offscreen.alignment
      : speaker.onscreen.alignment
    : style.alignment;
  const marginV1080 = speaker && separatorIndex >= 0
    ? isOffscreen
      ? speaker.offscreen.marginV1080
      : speaker.onscreen.marginV1080
    : style.marginV1080;
  const lineCount = Math.max(1, text.split(/\r?\n/).length);
  const outline = style.outlinePx1080 * scale;
  const bodyHeight = lineCount * style.lineHeightPx1080 * scale + outline * 2;
  const stackedExtra = speaker?.stackedLabel && separatorIndex >= 0
    ? (
      speaker.stackedLabel.fontSizePx1080 +
      speaker.stackedLabel.gapPx1080 +
      speaker.stackedLabel.outlinePx1080 * 2
    ) * scale
    : 0;
  const height = Math.min(frameHeight, Math.ceil(bodyHeight + stackedExtra));
  const width = Math.min(
    frameWidth,
    Math.ceil(frameWidth * style.maxWidthRatio + outline * 2),
  );
  const x = Math.floor((frameWidth - width) / 2);
  const marginV = Math.round(marginV1080 * scale);
  const y = alignment === "top_center"
    ? marginV - stackedExtra
    : alignment === "center"
    ? (frameHeight - height) / 2
    : frameHeight - marginV - height;
  return {
    x,
    y: Math.floor(y),
    width,
    height,
  };
}

function overlayLayer(
  clip: LayoutTimelineClip,
  frameWidth: number,
  frameHeight: number,
  safeArea: RenderLayoutSafeArea,
): RenderLayoutLayer | null {
  if (!validFrameRange(clip)) return null;
  const content = contentElement(clip);
  const templateRef = typeof content?.template_ref === "string"
    ? content.template_ref
    : legacyTemplateRef(clip);
  if (!templateRef) return null;
  const manifest = resolveContentTemplate(templateRef);
  const semanticRole = manifest?.semantic_role === "cta"
    ? "cta" as const
    : manifest?.semantic_role === "title"
    ? "title" as const
    : templateRef.endsWith("cta-card/v1")
    ? "cta" as const
    : templateRef.endsWith("title-card/v1") ||
        templateRef.endsWith("hook-title/v1")
    ? "title" as const
    : null;
  if (!semanticRole) return null;
  return {
    layer_id: clip.clip_id ?? `overlay-${clip.timeline_in_frame}`,
    semantic_role: semanticRole,
    source: manifest?.preferred_renderer === "hyperframes"
      ? "hyperframes"
      : "remotion",
    start_frame: clip.timeline_in_frame!,
    end_frame: clip.timeline_in_frame! + clip.timeline_duration_frames!,
    bounds: overlayBounds(
      templateRef,
      content?.layout,
      frameWidth,
      frameHeight,
      safeArea,
    ),
  };
}

function overlayBounds(
  templateRef: string,
  rawLayout: unknown,
  frameWidth: number,
  frameHeight: number,
  safeArea: RenderLayoutSafeArea,
): RenderLayoutBounds {
  const layout = asRecord(rawLayout);
  if (
    layout &&
    finiteNumber(layout.width) &&
    finiteNumber(layout.height) &&
    finiteNumber(layout.x) &&
    finiteNumber(layout.y)
  ) {
    const width = frameWidth * Number(layout.width);
    const height = frameHeight * Number(layout.height);
    const anchor = typeof layout.anchor === "string" ? layout.anchor : "center";
    const point = anchorPoint(anchor, frameWidth, frameHeight);
    const origin = anchorOrigin(anchor, width, height);
    return {
      x: point.x + Number(layout.x) * frameWidth - origin.x,
      y: point.y + Number(layout.y) * frameHeight - origin.y,
      width,
      height,
    };
  }
  if (templateRef.endsWith("cta-card/v1")) {
    return {
      x: safeArea.left,
      y: safeArea.top,
      width: frameWidth - safeArea.left - safeArea.right,
      height: frameHeight - safeArea.top - safeArea.bottom,
    };
  }
  if (templateRef.endsWith("hook-title/v1")) {
    return {
      x: safeArea.left,
      y: safeArea.top,
      width: Math.round(frameWidth * 0.86),
      height: Math.round(frameHeight * 0.3),
    };
  }
  return {
    x: Math.round(frameWidth * 0.14),
    y: Math.round(frameHeight * 0.3),
    width: Math.round(frameWidth * 0.72),
    height: Math.round(frameHeight * 0.4),
  };
}

function contentElement(clip: LayoutTimelineClip): Record<string, unknown> | null {
  const direct = asRecord(clip.content_element);
  if (direct) return direct;
  const metadata = asRecord(clip.metadata);
  return asRecord(metadata?.content_element);
}

function legacyTemplateRef(clip: LayoutTimelineClip): string | undefined {
  const metadata = asRecord(clip.metadata);
  const overlay = asRecord(metadata?.overlay);
  const styling = typeof overlay?.styling_class === "string"
    ? overlay.styling_class
    : "";
  if (/(?:^|\.|:)cta-card$/i.test(styling)) {
    return "vos:content.cta-card/v1";
  }
  if (/(?:^|\.|:)hook-title$/i.test(styling)) {
    return "vos:content.hook-title/v1";
  }
  if (/(?:^|\.|:)title-card$/i.test(styling)) {
    return "vos:content.title-card/v1";
  }
  return undefined;
}

function overlayText(clip: LayoutTimelineClip): string | undefined {
  const content = contentElement(clip);
  const props = asRecord(content?.props);
  for (const key of ["title", "headline", "text"]) {
    if (typeof props?.[key] === "string") return props[key] as string;
  }
  const metadata = asRecord(clip.metadata);
  const overlay = asRecord(metadata?.overlay);
  return typeof overlay?.text === "string" ? overlay.text : undefined;
}

function timelineDurationFrames(
  timeline: LayoutTimeline,
  layers: RenderLayoutLayer[],
): number {
  let duration = 0;
  for (
    const clip of [
      ...(timeline.tracks?.video?.flatMap((track) => track.clips ?? []) ?? []),
      ...(timeline.tracks?.overlay?.flatMap((track) => track.clips ?? []) ?? []),
    ]
  ) {
    if (!validFrameRange(clip)) continue;
    duration = Math.max(
      duration,
      clip.timeline_in_frame! + clip.timeline_duration_frames!,
    );
  }
  for (const layer of layers) duration = Math.max(duration, layer.end_frame);
  return duration;
}

function validFrameRange(clip: LayoutTimelineClip): boolean {
  return Number.isInteger(clip.timeline_in_frame) &&
    Number.isInteger(clip.timeline_duration_frames) &&
    clip.timeline_in_frame! >= 0 &&
    clip.timeline_duration_frames! > 0;
}

function normalizedVisibleText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\s。、，,.!?！？「」『』【】（）()｜|:：;；"'’“”]/gu, "")
    .toLowerCase();
}

function rangesOverlap(
  leftStart: number,
  leftEnd: number,
  rightStart: number,
  rightEnd: number,
): boolean {
  return Math.min(leftEnd, rightEnd) > Math.max(leftStart, rightStart);
}

function anchorPoint(
  anchor: string,
  width: number,
  height: number,
): { x: number; y: number } {
  return {
    x: anchor.endsWith("_left") ? 0 : anchor.endsWith("_right") ? width : width / 2,
    y: anchor.startsWith("top_") ? 0 : anchor.startsWith("bottom_") ? height : height / 2,
  };
}

function anchorOrigin(
  anchor: string,
  width: number,
  height: number,
): { x: number; y: number } {
  return {
    x: anchor.endsWith("_left") ? 0 : anchor.endsWith("_right") ? width : width / 2,
    y: anchor.startsWith("top_") ? 0 : anchor.startsWith("bottom_") ? height : height / 2,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
