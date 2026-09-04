import * as fs from "node:fs";
import * as path from "node:path";

export function writeTimeline(projectPath: string): void {
  const outputDir = path.join(projectPath, "05_timeline");
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, "timeline.json"), "{}");
}
