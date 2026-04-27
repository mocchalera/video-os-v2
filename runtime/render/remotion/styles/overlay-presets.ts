import { createElement, type CSSProperties, type JSX } from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { remotionDesignTokens as tokens } from "./design-tokens.js";

export interface OverlayPresetProps {
  text: string;
  writing_mode?: "horizontal_tb" | "vertical_rl" | "vertical_lr";
  anchor?: string;
  safe_area?: { top?: number; bottom?: number; left?: number; right?: number };
  durationInFrames: number;
  fps: number;
}

export interface OverlayPreset {
  id: string;
  render: (props: OverlayPresetProps) => JSX.Element;
}

type SafeArea = Required<NonNullable<OverlayPresetProps["safe_area"]>>;

type OverlayPosition = {
  alignItems: CSSProperties["alignItems"];
  justifyContent: CSSProperties["justifyContent"];
  paddingTop?: number;
  paddingRight?: number;
  paddingBottom?: number;
  paddingLeft?: number;
};

const DEFAULT_SAFE_AREA = tokens.safeAreas["16:9"];

function mergedSafeArea(safeArea: OverlayPresetProps["safe_area"]): SafeArea {
  return {
    top: safeArea?.top ?? DEFAULT_SAFE_AREA.top,
    right: safeArea?.right ?? DEFAULT_SAFE_AREA.right,
    bottom: safeArea?.bottom ?? DEFAULT_SAFE_AREA.bottom,
    left: safeArea?.left ?? DEFAULT_SAFE_AREA.left,
  };
}

function fadeOpacity(frame: number, durationInFrames: number, fadeFrames: number): number {
  const fade = Math.max(1, Math.min(fadeFrames, Math.floor(durationInFrames / 2)));
  const fadeIn = interpolate(frame, [0, fade], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const fadeOut = interpolate(frame, [durationInFrames - fade, durationInFrames], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return Math.min(fadeIn, fadeOut);
}

function textWritingMode(writingMode: OverlayPresetProps["writing_mode"]): CSSProperties {
  if (writingMode === "vertical_rl") {
    return { writingMode: "vertical-rl", textOrientation: "mixed" };
  }
  if (writingMode === "vertical_lr") {
    return { writingMode: "vertical-lr", textOrientation: "mixed" };
  }
  return { writingMode: "horizontal-tb" };
}

function overlayPosition(anchor: string | undefined, safeArea: SafeArea): OverlayPosition {
  switch (anchor) {
    case "top-left":
      return {
        alignItems: "flex-start",
        justifyContent: "flex-start",
        paddingTop: safeArea.top,
        paddingLeft: safeArea.left,
      };
    case "bottom-right":
      return {
        alignItems: "flex-end",
        justifyContent: "flex-end",
        paddingRight: safeArea.right,
        paddingBottom: safeArea.bottom,
      };
    case "bottom-center":
    case "center-bottom":
      return {
        alignItems: "center",
        justifyContent: "flex-end",
        paddingBottom: safeArea.bottom,
      };
    case "bottom-left":
      return {
        alignItems: "flex-start",
        justifyContent: "flex-end",
        paddingLeft: safeArea.left,
        paddingBottom: safeArea.bottom,
      };
    case "center":
    default:
      return {
        alignItems: "center",
        justifyContent: "center",
        paddingTop: safeArea.top,
        paddingRight: safeArea.right,
        paddingBottom: safeArea.bottom,
        paddingLeft: safeArea.left,
      };
  }
}

function overlayTextBox(children: JSX.Element, anchor: string | undefined, safeArea: SafeArea): JSX.Element {
  const position = overlayPosition(anchor, safeArea);

  return createElement(
    AbsoluteFill,
    {
      style: {
        alignItems: position.alignItems,
        justifyContent: position.justifyContent,
        paddingTop: position.paddingTop,
        paddingRight: position.paddingRight,
        paddingBottom: position.paddingBottom,
        paddingLeft: position.paddingLeft,
      },
    },
    children,
  );
}

function textElement(text: string, style: CSSProperties): JSX.Element {
  return createElement("div", { style }, text);
}

function titleCardRender(props: OverlayPresetProps): JSX.Element {
  const frame = useCurrentFrame();
  const safeArea = mergedSafeArea(props.safe_area);
  const opacity = fadeOpacity(frame, props.durationInFrames, tokens.durations.fade_medium);
  const translateY = interpolate(frame, [0, tokens.durations.fade_medium], [20, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return overlayTextBox(
    textElement(props.text, {
      ...textWritingMode(props.writing_mode),
      opacity,
      transform: `translateY(${translateY}px)`,
      maxWidth: "72%",
      color: tokens.colors.overlay.text,
      fontFamily: tokens.fontFamilies.heading,
      fontSize: tokens.fontSizes.title,
      fontWeight: 700,
      lineHeight: 1.08,
      textAlign: "center",
      textShadow: `0 4px 28px ${tokens.colors.overlay.shadow}`,
      whiteSpace: "pre-wrap",
    }),
    props.anchor ?? "center",
    safeArea,
  );
}

function lowerThirdRender(props: OverlayPresetProps): JSX.Element {
  const frame = useCurrentFrame();
  const safeArea = mergedSafeArea(props.safe_area);
  const opacity = fadeOpacity(frame, props.durationInFrames, tokens.durations.fade_short);
  const translateX = interpolate(frame, [0, tokens.durations.fade_medium], [-48, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return overlayTextBox(
    textElement(props.text, {
      ...textWritingMode(props.writing_mode),
      opacity,
      transform: `translateX(${translateX}px)`,
      maxWidth: "58%",
      padding: "18px 24px",
      color: tokens.colors.overlay.text,
      backgroundColor: tokens.colors.overlay.panel,
      borderLeft: `6px solid ${tokens.colors.overlay.accent}`,
      fontFamily: tokens.fontFamilies.heading,
      fontSize: tokens.fontSizes.lowerThird,
      fontWeight: 650,
      lineHeight: 1.16,
      textShadow: `0 2px 16px ${tokens.colors.overlay.shadow}`,
      whiteSpace: "pre-wrap",
    }),
    props.anchor ?? "bottom-left",
    safeArea,
  );
}

function chapterKickerRender(props: OverlayPresetProps): JSX.Element {
  const frame = useCurrentFrame();
  const safeArea = mergedSafeArea(props.safe_area);
  const opacity = fadeOpacity(frame, props.durationInFrames, tokens.durations.fade_short);

  return overlayTextBox(
    textElement(props.text, {
      ...textWritingMode(props.writing_mode),
      opacity,
      maxWidth: "48%",
      color: tokens.colors.overlay.text,
      fontFamily: tokens.fontFamilies.body,
      fontSize: tokens.fontSizes.kicker,
      fontWeight: 700,
      lineHeight: 1.18,
      letterSpacing: 0,
      textShadow: `0 2px 18px ${tokens.colors.overlay.shadow}`,
      whiteSpace: "pre-wrap",
    }),
    props.anchor ?? "top-left",
    safeArea,
  );
}

function locationTagRender(props: OverlayPresetProps): JSX.Element {
  const frame = useCurrentFrame();
  const safeArea = mergedSafeArea(props.safe_area);
  const opacity = fadeOpacity(frame, props.durationInFrames, tokens.durations.fade_short);

  return overlayTextBox(
    textElement(props.text, {
      ...textWritingMode(props.writing_mode),
      opacity,
      maxWidth: "42%",
      padding: "10px 14px",
      color: tokens.colors.overlay.mutedText,
      backgroundColor: tokens.colors.overlay.panelSoft,
      fontFamily: tokens.fontFamilies.mono,
      fontSize: tokens.fontSizes.tag,
      fontWeight: 600,
      lineHeight: 1.2,
      textAlign: "right",
      textShadow: `0 2px 12px ${tokens.colors.overlay.shadow}`,
      textTransform: "uppercase",
      whiteSpace: "pre-wrap",
    }),
    props.anchor ?? "bottom-right",
    safeArea,
  );
}

function creditRender(props: OverlayPresetProps): JSX.Element {
  const frame = useCurrentFrame();
  const safeArea = mergedSafeArea(props.safe_area);
  const opacity = fadeOpacity(frame, props.durationInFrames, tokens.durations.fade_long);

  return overlayTextBox(
    textElement(props.text, {
      ...textWritingMode(props.writing_mode),
      opacity,
      maxWidth: "64%",
      color: tokens.colors.overlay.text,
      fontFamily: tokens.fontFamilies.body,
      fontSize: tokens.fontSizes.credit,
      fontWeight: 500,
      lineHeight: 1.28,
      textAlign: "center",
      textShadow: `0 3px 22px ${tokens.colors.overlay.shadow}`,
      whiteSpace: "pre-wrap",
    }),
    props.anchor ?? "center-bottom",
    safeArea,
  );
}

export const overlayPresets: ReadonlyMap<string, OverlayPreset> = new Map([
  ["vos:overlay.title-card", { id: "vos:overlay.title-card", render: titleCardRender }],
  ["vos:overlay.lower-third", { id: "vos:overlay.lower-third", render: lowerThirdRender }],
  ["vos:overlay.chapter-kicker", { id: "vos:overlay.chapter-kicker", render: chapterKickerRender }],
  ["vos:overlay.location-tag", { id: "vos:overlay.location-tag", render: locationTagRender }],
  ["vos:overlay.credit", { id: "vos:overlay.credit", render: creditRender }],
]);

export function resolveOverlayPreset(stylingClass: string): OverlayPreset | null {
  return overlayPresets.get(stylingClass) ?? null;
}

export function getOverlayText(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object") return null;
  const m = metadata as Record<string, unknown>;
  const overlay = m.overlay as Record<string, unknown> | undefined;
  if (overlay && typeof overlay.text === "string") return overlay.text;
  if (typeof m.text === "string") return m.text;
  if (typeof m.overlay_text === "string") return m.overlay_text;
  return null;
}
