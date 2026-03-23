// CLI entry point for preview segment rendering.
// Usage:
//   npx tsx scripts/preview-segment.ts <project-path> [--beat <beat-name>] [--first-n-sec 30]

import * as fs from "node:fs";
import * as path from "node:path";
import { renderPreviewSegment } from "../runtime/preview/segment-renderer.js";
import { generateTimelineOverview } from "../runtime/preview/timeline-overview.js";
import { loadSourceMap } from "../runtime/media/source-map.js";

// ── Arg parsing ─────────────────────────────────────────────────────

interface PreviewArgs {
  projectPath: string;
  beatId?: string;
  firstNSec?: number;
  sourceMapPath?: string;
  overviewOnly?: boolean;
}

function parseArgs(): PreviewArgs {
  const args = process.argv.slice(2);
  let projectPath: string | undefined;
  let beatId: string | undefined;
  let firstNSec: number | undefined;
  let sourceMapPath: string | undefined;
  let overviewOnly = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--beat" && i + 1 < args.length) {
      beatId = args[++i];
    } else if (args[i] === "--first-n-sec" && i + 1 < args.length) {
      firstNSec = parseInt(args[++i], 10);
      if (Number.isNaN(firstNSec) || firstNSec <= 0) {
        console.error("--first-n-sec must be a positive integer");
        process.exit(1);
      }
    } else if (args[i] === "--source-map" && i + 1 < args.length) {
      sourceMapPath = args[++i];
    } else if (args[i] === "--overview-only") {
      overviewOnly = true;
    } else if (!projectPath) {
      projectPath = args[i];
    }
  }

  if (!projectPath) {
    console.error(
      "Usage: npx tsx scripts/preview-segment.ts <project-path> [--beat <beat-name>] [--first-n-sec 30] [--source-map <file>] [--overview-only]",
    );
    process.exit(1);
  }

  return { projectPath, beatId, firstNSec, sourceMapPath, overviewOnly };
}

// ── Main ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { projectPath, beatId, firstNSec, sourceMapPath, overviewOnly } = parseArgs();

  const absProject = path.resolve(projectPath);
  const timelinePath = path.join(absProject, "05_timeline/timeline.json");

  if (!fs.existsSync(timelinePath)) {
    console.error(`Timeline not found: ${timelinePath}`);
    console.error("Run compile first before generating a preview.");
    process.exit(1);
  }

  const sourceMap = loadSourceMap(absProject, sourceMapPath);

  if (overviewOnly) {
    // Generate only the overview contact sheet
    console.log("Generating timeline overview...");
    const overview = await generateTimelineOverview({
      projectDir: absProject,
      timelinePath,
      sourceMap,
    });
    console.log(`Timeline overview: ${overview.outputPath}`);
    console.log(`  Clips: ${overview.clipCount}`);
    return;
  }

  // Render the preview segment
  console.log("Rendering preview segment...");
  if (beatId) {
    console.log(`  Beat filter: ${beatId}`);
  }
  if (firstNSec) {
    console.log(`  Duration limit: first ${firstNSec}s`);
  }

  const result = await renderPreviewSegment({
    projectDir: absProject,
    timelinePath,
    sourceMap,
    beatId,
    firstNSec,
  });

  console.log(`Preview rendered: ${result.outputPath}`);
  console.log(`  Clips: ${result.clipCount}`);
  console.log(`  Duration: ${result.durationSec.toFixed(1)}s`);

  // Also generate the overview contact sheet
  console.log("Generating timeline overview...");
  try {
    const overview = await generateTimelineOverview({
      projectDir: absProject,
      timelinePath,
      sourceMap,
    });
    console.log(`Timeline overview: ${overview.outputPath}`);
    console.log(`  Clips: ${overview.clipCount}`);
  } catch (err) {
    console.error(`Warning: Overview generation failed: ${String(err)}`);
  }
}

main().catch((err) => {
  console.error(`Preview failed: ${String(err)}`);
  process.exit(1);
});
