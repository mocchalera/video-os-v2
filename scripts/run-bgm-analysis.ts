#!/usr/bin/env npx tsx
/**
 * Quick BGM analysis runner for testing.
 * Usage: npx tsx scripts/run-bgm-analysis.ts <audio-path> <project-path>
 */

import { detectBgmBeats, writeBgmAnalysis } from "../runtime/connectors/bgm-beat-detector.js";

const audioPath = process.argv[2];
const projectPath = process.argv[3] ?? "projects/sample-project";

if (!audioPath) {
  console.error("Usage: npx tsx scripts/run-bgm-analysis.ts <audio-path> [project-path]");
  process.exit(1);
}

const analysis = detectBgmBeats({
  audioPath,
  projectId: projectPath.split("/").pop() ?? "unknown",
  assetId: "AST_BGM_PIXEL_HEART",
  sampleRate: 48000,
  meter: "4/4",
});

const outPath = writeBgmAnalysis(analysis, projectPath);
console.log(JSON.stringify(analysis, null, 2));
console.log("\nWritten to:", outPath);
