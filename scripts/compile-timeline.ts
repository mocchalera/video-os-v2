// CLI entry point for the timeline compiler.
// Usage: npx tsx scripts/compile-timeline.ts projects/sample

import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { compile } from "../runtime/compiler/index.js";
import { validateProject } from "./validate-schemas.js";

function main(): void {
  const projectPath = process.argv[2];
  if (!projectPath) {
    console.error(
      "Usage: npx tsx scripts/compile-timeline.ts <project-path>",
    );
    process.exit(1);
  }

  // Pre-compile validation: check Gate 1
  const preCheck = validateProject(projectPath);
  if (preCheck.compile_gate === "blocked") {
    console.error("Compile gate BLOCKED. Unresolved blockers exist.");
    for (const v of preCheck.violations) {
      if (v.rule === "compile_gate") {
        console.error(`  - ${v.message}`);
      }
    }
    process.exit(1);
  }

  // Derive createdAt deterministically from the creative brief's created_at
  const briefPath = path.join(path.resolve(projectPath), "01_intent/creative_brief.yaml");
  const briefRaw = fs.readFileSync(briefPath, "utf-8");
  const brief = parseYaml(briefRaw) as { created_at?: string };
  const createdAt = brief.created_at ?? "1970-01-01T00:00:00Z";

  // Compile
  const result = compile({
    projectPath,
    createdAt,
  });

  console.log(`Timeline compiled: ${result.outputPath}`);
  console.log(`  Tracks: ${result.timeline.tracks.video.length} video, ${result.timeline.tracks.audio.length} audio`);
  console.log(`  Markers: ${result.timeline.markers.length}`);
  console.log(`  Resolution: ${JSON.stringify(result.resolution)}`);

  // Post-compile validation: check Gate 2
  const postCheck = validateProject(projectPath);
  if (!postCheck.gate2_timeline_valid) {
    console.error("WARNING: Generated timeline.json has validation issues:");
    for (const v of postCheck.violations) {
      if (v.artifact === "05_timeline/timeline.json") {
        console.error(`  - [${v.rule}] ${v.message}`);
      }
    }
    process.exit(1);
  }

  console.log("Schema validation: PASSED");
}

main();
