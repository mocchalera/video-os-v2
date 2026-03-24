import type { EditBlueprint } from "./index.js";

export function validateConfirmedPreferences(
  blueprint: EditBlueprint,
  autonomyMode: "full" | "collaborative",
): string[] {
  const prefs = blueprint.pacing?.confirmed_preferences;
  if (!prefs) {
    return ["pacing.confirmed_preferences is required"];
  }

  const expectedSource = autonomyMode === "full" ? "ai_autonomous" : "human_confirmed";
  const errors: string[] = [];
  if (prefs.mode !== autonomyMode) {
    errors.push(`pacing.confirmed_preferences.mode must be "${autonomyMode}"`);
  }
  if (prefs.source !== expectedSource) {
    errors.push(`pacing.confirmed_preferences.source must be "${expectedSource}"`);
  }
  if (typeof prefs.duration_target_sec !== "number" || prefs.duration_target_sec <= 0) {
    errors.push("pacing.confirmed_preferences.duration_target_sec must be > 0");
  }
  if (typeof prefs.confirmed_at !== "string" || prefs.confirmed_at.length === 0) {
    errors.push("pacing.confirmed_preferences.confirmed_at is required");
  }
  return errors;
}

export function recordAutonomousConfirmedPreferences(
  blueprint: EditBlueprint,
  briefContent: {
    project?: { runtime_target_sec?: number };
  },
): void {
  const existing = blueprint.pacing?.confirmed_preferences;
  if (!blueprint.pacing) {
    return;
  }

  blueprint.pacing.confirmed_preferences = {
    ...existing,
    mode: "full",
    source: "ai_autonomous",
    duration_target_sec: typeof existing?.duration_target_sec === "number" &&
        existing.duration_target_sec > 0
      ? existing.duration_target_sec
      : briefContent.project?.runtime_target_sec ?? 120,
    confirmed_at: typeof existing?.confirmed_at === "string" &&
        existing.confirmed_at.length > 0
      ? existing.confirmed_at
      : new Date().toISOString(),
  };
}
