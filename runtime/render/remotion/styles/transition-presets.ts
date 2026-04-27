import {
  createElement,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from "react";
import { AbsoluteFill } from "remotion";

export interface TransitionPresetProps {
  progress: number;
  opacity?: number;
  durationInFrames?: number;
  children?: ReactNode;
  metadata?: Record<string, unknown>;
}

export interface TransitionPreset {
  id: string;
  requiresHandles: boolean;
  render: (props: TransitionPresetProps) => ReactElement | null;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function dipOpacity(progress: number, maxOpacity = 1): number {
  return clamp01((1 - Math.abs(progress - 0.5) * 2) * maxOpacity);
}

function fill(
  style: CSSProperties,
  children?: ReactNode,
): ReactElement {
  return createElement(AbsoluteFill, { style }, children);
}

export const transitionPresets: ReadonlyMap<string, TransitionPreset> = new Map<string, TransitionPreset>([
  [
    "cut",
    {
      id: "cut",
      requiresHandles: false,
      render: () => null,
    },
  ],
  [
    "crossfade",
    {
      id: "crossfade",
      requiresHandles: true,
      render: ({ opacity, children }) =>
        fill(
          {
            opacity: opacity ?? 1,
            pointerEvents: "none",
          },
          children,
        ),
    },
  ],
  [
    "fade_to_black",
    {
      id: "fade_to_black",
      requiresHandles: false,
      render: ({ progress }) =>
        fill({
          backgroundColor: "black",
          opacity: dipOpacity(progress),
          pointerEvents: "none",
        }),
    },
  ],
  [
    "dip_to_white",
    {
      id: "dip_to_white",
      requiresHandles: false,
      render: ({ progress }) =>
        fill({
          backgroundColor: "white",
          opacity: dipOpacity(progress),
          pointerEvents: "none",
        }),
    },
  ],
  [
    "match_cut_soft",
    {
      id: "match_cut_soft",
      requiresHandles: true,
      render: ({ opacity, children }) =>
        fill(
          {
            opacity: Math.min(opacity ?? 1, 0.4),
            pointerEvents: "none",
          },
          children,
        ),
    },
  ],
]);

export function resolveTransitionPreset(
  transitionType: string,
): TransitionPreset | null {
  return transitionPresets.get(transitionType) ?? null;
}
