import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";

export type AutonomyMode = "full" | "collaborative";

interface BriefAutonomyShape {
  autonomy?: {
    mode?: AutonomyMode;
    must_ask?: string[];
  };
}

export function inferAutonomyMode(
  briefContent: BriefAutonomyShape | null | undefined,
): AutonomyMode {
  if (briefContent?.autonomy?.mode) {
    return briefContent.autonomy.mode;
  }
  return (briefContent?.autonomy?.must_ask?.length ?? 1) === 0
    ? "full"
    : "collaborative";
}

export function readCreativeBriefAutonomyMode(
  projectDir: string,
): AutonomyMode | null {
  const briefPath = path.join(projectDir, "01_intent/creative_brief.yaml");
  if (!fs.existsSync(briefPath)) {
    return null;
  }

  const briefRaw = fs.readFileSync(briefPath, "utf-8");
  const briefContent = parseYaml(briefRaw) as BriefAutonomyShape;
  return inferAutonomyMode(briefContent);
}
