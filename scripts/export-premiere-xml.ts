#!/usr/bin/env npx tsx
/**
 * CLI: Export timeline.json to Premiere Pro XML (FCP7 format)
 *
 * Usage:
 *   npx tsx scripts/export-premiere-xml.ts <project-path> [--source-map <source-map.json>]
 *
 * The source map JSON accepts:
 * - legacy maps: { "AST_31A9CDC2": "/path/to/file.MOV", ... }
 * - 02_media/source_map.json
 * - handoff manifests with source_map[]
 *
 * If --source-map is not provided, the script will first look for
 * 02_media/source_map.json, then fall back to older 03_analysis heuristics.
 *
 * Output: <project-path>/09_output/<project_id>_premiere.xml
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { TimelineIR } from "../runtime/compiler/types.js";
import { timelineToFcp7Xml } from "../runtime/handoff/fcp7-xml-export.js";
import { loadSourceMap } from "../runtime/media/source-map.js";

// ── Arg parsing ─────────────────────────────────────────────────────

function parseArgs(): {
  projectPath: string;
  sourceMapPath?: string;
} {
  const args = process.argv.slice(2);
  let projectPath: string | undefined;
  let sourceMapPath: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--source-map" && i + 1 < args.length) {
      sourceMapPath = args[++i];
    } else if (!projectPath) {
      projectPath = args[i];
    }
  }

  if (!projectPath) {
    console.error(
      "Usage: npx tsx scripts/export-premiere-xml.ts <project-path> [--source-map <file>]",
    );
    process.exit(1);
  }

  return { projectPath: path.resolve(projectPath), sourceMapPath };
}

// ── Source map resolution ───────────────────────────────────────────

function resolveSourceMap(
  projectPath: string,
  sourceMapPath?: string,
): Map<string, string> {
  if (sourceMapPath && !fs.existsSync(path.resolve(sourceMapPath))) {
    throw new Error(`source map not found: ${path.resolve(sourceMapPath)}`);
  }

  const loaded = loadSourceMap(projectPath, sourceMapPath);
  if (loaded.locatorMap.size > 0) {
    return loaded.locatorMap;
  }

  const map = new Map<string, string>();

  // Try to auto-resolve from analysis directory
  const analysisDir = path.join(projectPath, "03_analysis");
  if (fs.existsSync(analysisDir)) {
    // Look for asset manifest or analysis files
    const files = fs.readdirSync(analysisDir);
    for (const file of files) {
      if (file.endsWith(".json")) {
        try {
          const data = JSON.parse(
            fs.readFileSync(path.join(analysisDir, file), "utf-8"),
          );
          if (data.asset_id && data.source_path) {
            map.set(data.asset_id, data.source_path);
          }
        } catch {
          // Skip unparseable files
        }
      }
    }
  }

  return map;
}

// ── Main ────────────────────────────────────────────────────────────

function main(): void {
  const { projectPath, sourceMapPath } = parseArgs();

  // Read timeline.json
  const timelinePath = path.join(projectPath, "05_timeline", "timeline.json");
  if (!fs.existsSync(timelinePath)) {
    console.error(`timeline.json not found: ${timelinePath}`);
    process.exit(1);
  }

  const timeline: TimelineIR = JSON.parse(
    fs.readFileSync(timelinePath, "utf-8"),
  );
  console.log(`Timeline: ${timeline.sequence.name}`);
  console.log(
    `  Tracks: ${timeline.tracks.video.length}V + ${timeline.tracks.audio.length}A`,
  );
  console.log(
    `  Clips: ${timeline.tracks.video.reduce((n, t) => n + t.clips.length, 0) + timeline.tracks.audio.reduce((n, t) => n + t.clips.length, 0)}`,
  );

  // Resolve source map
  const sourceMap = resolveSourceMap(projectPath, sourceMapPath);
  if (sourceMap.size === 0) {
    console.error(
      "Error: No source map entries found. Cannot produce valid Premiere XML without media references.",
    );
    console.error(
      "  Use --source-map <file.json> to provide asset_id → file path mapping,",
    );
    console.error(
      "  or generate 02_media/source_map.json via scripts/analyze.ts.",
    );
    process.exit(1);
  } else {
    console.log(`  Source map: ${sourceMap.size} entries`);
  }

  // Export
  const xml = timelineToFcp7Xml(timeline, { sourceMap });

  // Write output
  const outputDir = path.join(projectPath, "09_output");
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(
    outputDir,
    `${timeline.project_id}_premiere.xml`,
  );
  fs.writeFileSync(outputPath, xml, "utf-8");

  console.log(`\nExported: ${outputPath}`);
  console.log(
    `  → Premiere Pro: File → Import → select this XML`,
  );
}

main();
