export const TALKING_HEAD_PACING_SKILL_ID = "talking_head_pacing";
export const DIALOGUE_CUT_FADE_DEFAULT_MS = 40;

export function dialogueCutFadeSec(
  clipDurationSec: number,
  enabled: boolean,
): number {
  if (!enabled || !Number.isFinite(clipDurationSec) || clipDurationSec <= 0) {
    return 0;
  }
  return Math.min(DIALOGUE_CUT_FADE_DEFAULT_MS / 1000, clipDurationSec / 4);
}
