import type { CSSProperties } from "react";

/**
 * Deterministic mapping from ContentElementV1 layout fields to Remotion
 * sequence-pixel/DOM styles. Mirrors the hyperframes contract in
 * runtime/content/hyperframes-html.ts:
 *
 * - the anchor picks the reference point on the sequence frame;
 * - safe_area insets by the renderer's safe margins inward from the
 *   anchored edge (hyperframes --safe-x/--safe-y parity);
 * - normalized x/y offset the element by a fraction of the frame size;
 * - an explicit width/height wins over auto sizing and pins an absolutely
 *   positioned element box;
 * - scale and rotation pivot on the anchor point so the anchor position
 *   never moves, whatever the scale.
 */

export interface OverlayFrameDimensions {
  width: number;
  height: number;
}

export interface OverlayLayoutSpec {
  /** Kebab-case anchor as produced by overlay-clip-resolver. */
  anchor?: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  scale: number;
  rotationDeg: number;
  opacity: number;
  safeArea: boolean;
  zIndex?: number;
}

type AnchorPoint = readonly [column: number, row: number];

const ANCHOR_POINTS: Record<string, AnchorPoint> = {
  "top-left": [0, 0],
  "top-center": [0.5, 0],
  "top-right": [1, 0],
  "center-left": [0, 0.5],
  center: [0.5, 0.5],
  "center-right": [1, 0.5],
  "bottom-left": [0, 1],
  "bottom-center": [0.5, 1],
  "bottom-right": [1, 1],
};

/** Hyperframes-parity safe margins (--safe-x/--safe-y in hyperframes-html.ts). */
export function overlaySafeMargins(frame: OverlayFrameDimensions): { x: number; y: number } {
  return {
    x: Math.round(frame.width * 0.05),
    y: Math.round(frame.height * 0.067),
  };
}

export function anchorTransformOrigin(anchor?: string): string {
  const [column, row] = anchorPoint(anchor);
  return `${column * 100}% ${row * 100}%`;
}

export function hasExplicitRect(width?: number, height?: number): boolean {
  return width !== undefined || height !== undefined;
}

function anchorPoint(anchor?: string): AnchorPoint {
  const normalized = anchor?.replaceAll("_", "-");
  return ANCHOR_POINTS[normalized ?? "center"] ?? ANCHOR_POINTS.center;
}

export function overlayWrapperStyle(
  spec: OverlayLayoutSpec,
  frame: OverlayFrameDimensions,
): CSSProperties {
  const style: CSSProperties = {};
  if (spec.opacity !== 1) style.opacity = spec.opacity;
  if (spec.zIndex !== undefined) style.zIndex = spec.zIndex;

  if (!hasExplicitRect(spec.width, spec.height)) {
    // Anchor mode: full-frame layer; the preset positions content with its
    // own flex/safe-area logic. Pivot on the anchor point so scaling keeps
    // the anchored corner/edge/center exactly where it was.
    style.transformOrigin = anchorTransformOrigin(spec.anchor);
    style.transform =
      `translate(${spec.x * 100}%, ${spec.y * 100}%) scale(${spec.scale}) rotate(${spec.rotationDeg}deg)`;
    return style;
  }

  // Explicit rect mode: absolutely positioned box sized in sequence pixels.
  // transform-origin sits on the box's anchor corner so translate centers
  // that corner onto the anchor point and scale/rotate keep it pinned.
  const [column, row] = anchorPoint(spec.anchor);
  const margins = overlaySafeMargins(frame);
  const insetX = spec.safeArea ? margins.x : 0;
  const insetY = spec.safeArea ? margins.y : 0;
  style.position = "absolute";
  style.left = column * frame.width + (column === 1 ? -insetX : insetX) + spec.x * frame.width;
  style.top = row * frame.height + (row === 1 ? -insetY : insetY) + spec.y * frame.height;
  if (spec.width !== undefined) style.width = spec.width * frame.width;
  // HyperFrames leaves an omitted axis as intrinsic `auto`. Remotion's
  // presets are absolute-fill trees, so out-of-flow children cannot establish
  // that auto size; keep it auto while giving the containing block a minimal
  // non-zero floor. Do not promote the omitted axis to the full frame.
  if (spec.width === undefined) style.minWidth = 1;
  if (spec.height !== undefined) style.height = spec.height * frame.height;
  if (spec.height === undefined) style.minHeight = 1;
  style.transformOrigin = `${column * 100}% ${row * 100}%`;
  style.transform =
    `translate(${-column * 100}%, ${-row * 100}%) scale(${spec.scale}) rotate(${spec.rotationDeg}deg)`;
  return style;
}
