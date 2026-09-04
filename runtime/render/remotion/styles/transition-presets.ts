import {
  Fragment,
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
  /**
   * Real outgoing (A) / incoming (B) media for the Issue #34 A/B roll
   * presets. The transition layer mutes and window-aligns both; presets
   * composite them so the window shows a true blend instead of the
   * premature hard cut the underlying clip Sequences paint.
   */
  childrenA?: ReactNode;
  childrenB?: ReactNode;
  /**
   * Frame index inside the transition window (Sequence-local, 0-based).
   * For light_leak_flash the window is two-sided (blend + decay tail), so
   * the flare envelope is computed from this rather than from `progress`.
   */
  localFrame?: number;
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
  // ── Issue #34 semantic presets (A/B roll overlap) ──────────────────
  [
    "film_crossfade",
    {
      id: "film_crossfade",
      requiresHandles: true,
      // Linear dissolve over real media: B sits beneath, A fades out on
      // top — matching the ffmpeg xfade=fade the final render performs.
      render: ({ progress, childrenA, childrenB }) =>
        fill(
          { pointerEvents: "none" },
          createElement(
            Fragment,
            null,
            childrenB ?? null,
            childrenA != null && progress < 1
              ? fill(
                  { opacity: 1 - progress, pointerEvents: "none" },
                  childrenA,
                )
              : null,
          ),
        ),
    },
  ],
  [
    "light_leak_flash",
    {
      id: "light_leak_flash",
      requiresHandles: true,
      // Two-sided window over real media. During the blend phase A melts
      // into B while the amber radial flare ramps up, peaking exactly on
      // the SEAM frame (localFrame == durationInFrames / 2 — the compiler's
      // flash_peak_frame, i.e. the chorus head); the flare then decays over
      // the declared post-seam window while B remains visible. This mirrors
      // the ffmpeg envelope (fade-in over the blend, chained fade-out over
      // the tail) frame-for-frame.
      render: ({ progress, localFrame = 0, durationInFrames = 1, childrenA, childrenB }) => {
        const peakAt = durationInFrames / 2;
        const n = Math.max(0, localFrame);
        const flare = n <= peakAt
          ? peakAt > 0
            ? n / peakAt
            : 1
          : Math.max(0, 1 - (n - peakAt) / Math.max(1, durationInFrames - peakAt));
        const showA = childrenA != null && n < peakAt && progress < 1;
        return fill(
          { pointerEvents: "none" },
          createElement(
            Fragment,
            null,
            childrenB ?? null,
            showA
              ? fill(
                  { opacity: 1 - progress, pointerEvents: "none" },
                  childrenA,
                )
              : null,
            flare > 0
              ? createElement(AbsoluteFill, {
                  style: {
                    background:
                      "radial-gradient(circle at 50% 50%, rgba(255,196,110,0.95) 0%, rgba(255,150,60,0.55) 35%, rgba(80,200,255,0.28) 62%, rgba(0,0,0,0) 78%)",
                    mixBlendMode: "screen",
                    opacity: clamp01(flare),
                    pointerEvents: "none",
                  } satisfies CSSProperties,
                })
              : null,
          ),
        );
      },
    },
  ],
  [
    "dreamy_focus_blur",
    {
      id: "dreamy_focus_blur",
      requiresHandles: true,
      // Sharp→soft→sharp over real media: both children share the smooth
      // sine blur ramp while A fades out on top of B, so the window never
      // pops at either boundary. The filter is omitted entirely when the
      // envelope is 0 — a zero-strength CSS blur still routes the layer
      // through a different rasterization path and would perturb the
      // window-edge frames against the unstyled render.
      render: ({ progress, childrenA, childrenB }) => {
        const blurPx = 6 * Math.sin(Math.PI * progress);
        const filter = blurPx > 0.05 ? `blur(${blurPx.toFixed(2)}px)` : undefined;
        const style: CSSProperties = { pointerEvents: "none", ...(filter ? { filter } : {}) };
        return fill(
          style,
          createElement(
            Fragment,
            null,
            childrenB != null ? fill(style, childrenB) : null,
            childrenA != null && progress < 1
              ? fill(
                  { ...style, opacity: 1 - progress },
                  childrenA,
                )
              : null,
          ),
        );
      },
    },
  ],
]);

export function resolveTransitionPreset(
  transitionType: string,
): TransitionPreset | null {
  return transitionPresets.get(transitionType) ?? null;
}
