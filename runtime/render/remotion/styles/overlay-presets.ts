import type { JSX } from "react";

export interface OverlayPresetProps {
  text?: string;
  metadata?: Record<string, unknown>;
}

export interface OverlayPreset {
  id: string;
  render: (props: OverlayPresetProps) => JSX.Element;
}

export const overlayPresets: ReadonlyMap<string, OverlayPreset> = new Map();

export function resolveOverlayPreset(stylingClass: string): OverlayPreset | null {
  return overlayPresets.get(stylingClass) ?? null;
}

