#!/usr/bin/env npx tsx
/**
 * Quick BGM analysis runner for testing.
 * Usage: npx tsx scripts/run-bgm-analysis.ts <audio-path> <project-path>
 */

import { analyzeBgm, writeBgmAnalysis } from "../runtime/media/bgm-analyzer.js";
import { enrichMusicCuesWithBeatGrid, type MusicCuesDoc } from "../runtime/audio/music-cues.js";
import fs from "node:fs";
import path from "node:path";

const audioPath = process.argv[2];
const projectPath = process.argv[3] ?? "projects/demo";

if (!audioPath) {
  console.error("Usage: npx tsx scripts/run-bgm-analysis.ts <audio-path> [project-path]");
  process.exit(1);
}

function resolveAssetId(projectDir: string, targetAudioPath: string): string {
  const assetsPath = path.join(projectDir, "03_analysis", "assets.json");
  if (!fs.existsSync(assetsPath)) return "AST_BGM";

  const parsed = JSON.parse(fs.readFileSync(assetsPath, "utf-8")) as {
    items?: Array<{ asset_id?: string; filename?: string }>;
  };
  const targetBase = path.basename(targetAudioPath);
  const match = parsed.items?.find((item) => item.filename === targetBase);
  return match?.asset_id ?? "AST_BGM";
}

const analysis = analyzeBgm({
  audioPath,
  projectDir: projectPath,
  projectId: projectPath.split("/").pop() ?? "unknown",
  assetId: resolveAssetId(projectPath, audioPath),
  sampleRate: 48000,
  meter: "4/4",
});

const outPath = writeBgmAnalysis(analysis, projectPath);
console.log(JSON.stringify(analysis, null, 2));
console.log("\nWritten to:", outPath);

const musicCuesPath = path.join(projectPath, "07_package", "music_cues.json");
if (analysis.analysis_status === "ready" && fs.existsSync(musicCuesPath)) {
  const doc = JSON.parse(fs.readFileSync(musicCuesPath, "utf-8")) as MusicCuesDoc;
  const enriched = enrichMusicCuesWithBeatGrid(doc, analysis);
  fs.writeFileSync(musicCuesPath, `${JSON.stringify(enriched, null, 2)}\n`, "utf-8");
  console.log("Updated music cues beat grid:", musicCuesPath);
}
