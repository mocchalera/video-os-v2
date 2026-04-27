export interface TransitionPresetProps {
  progress: number;
  metadata?: Record<string, unknown>;
}

export interface TransitionPreset {
  id: string;
  render: (props: TransitionPresetProps) => unknown;
}

export const transitionPresets: ReadonlyMap<string, TransitionPreset> = new Map();

export function resolveTransitionPreset(
  transitionType: string,
): TransitionPreset | null {
  return transitionPresets.get(transitionType) ?? null;
}

