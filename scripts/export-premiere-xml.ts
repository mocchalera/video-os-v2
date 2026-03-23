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
import {
  timelineToFcp7Xml,
  type TextOverlay,
} from "../runtime/handoff/fcp7-xml-export.js";
import { loadSourceMap, type LoadedSourceMap } from "../runtime/media/source-map.js";

// ── Arg parsing ─────────────────────────────────────────────────────

function parseArgs(): {
  projectPath: string;
  sourceMapPath?: string;
  titlesPath?: string;
  autoTitles: boolean;
} {
  const args = process.argv.slice(2);
  let projectPath: string | undefined;
  let sourceMapPath: string | undefined;
  let titlesPath: string | undefined;
  let autoTitles = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--source-map" && i + 1 < args.length) {
      sourceMapPath = args[++i];
    } else if (args[i] === "--titles" && i + 1 < args.length) {
      titlesPath = args[++i];
    } else if (args[i] === "--auto-titles") {
      autoTitles = true;
    } else if (!projectPath) {
      projectPath = args[i];
    }
  }

  if (!projectPath) {
    console.error(
      "Usage: npx tsx scripts/export-premiere-xml.ts <project-path> [options]",
    );
    console.error("Options:");
    console.error("  --source-map <file>  Asset ID → file path mapping");
    console.error("  --titles <file>      Text overlay definitions (JSON)");
    console.error("  --auto-titles        Generate overlays from timeline markers");
    process.exit(1);
  }

  return { projectPath: path.resolve(projectPath), sourceMapPath, titlesPath, autoTitles };
}

// ── Source map resolution ───────────────────────────────────────────

function resolveSourceMap(
  projectPath: string,
  sourceMapPath?: string,
): { locatorMap: Map<string, string>; displayNameMap: Map<string, string> } {
  if (sourceMapPath && !fs.existsSync(path.resolve(sourceMapPath))) {
    throw new Error(`source map not found: ${path.resolve(sourceMapPath)}`);
  }

  const loaded = loadSourceMap(projectPath, sourceMapPath);

  // Build display name map from source map entries
  const displayNameMap = new Map<string, string>();
  for (const entry of loaded.entries) {
    if (entry.display_name) {
      displayNameMap.set(entry.asset_id, entry.display_name);
    }
  }

  if (loaded.locatorMap.size > 0) {
    return { locatorMap: loaded.locatorMap, displayNameMap };
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

  return { locatorMap: map, displayNameMap };
}

// ── Main ────────────────────────────────────────────────────────────

// ── Title overlay resolution ────────────────────────────────────────

function resolveTextOverlays(
  timeline: TimelineIR,
  titlesPath?: string,
  autoTitles?: boolean,
): TextOverlay[] {
  // Explicit titles file takes priority
  if (titlesPath) {
    const raw = JSON.parse(fs.readFileSync(path.resolve(titlesPath), "utf-8"));
    const items: TextOverlay[] = Array.isArray(raw) ? raw : raw.overlays ?? [];
    console.log(`  Titles: ${items.length} from ${titlesPath}`);
    return items;
  }

  // Auto-generate from timeline markers (beat markers → lower-third labels)
  if (autoTitles && timeline.markers.length > 0) {
    const fps = timeline.sequence.fps_num / (timeline.sequence.fps_den || 1);
    const defaultDurFrames = Math.round(5 * fps); // 5 seconds

    const overlays: TextOverlay[] = timeline.markers
      .filter((m) => m.kind === "beat" || m.kind === "note")
      .map((m) => {
        // Strip "b01: " prefix from beat labels if present
        const text = m.label.replace(/^b\d+:\s*/, "");
        return {
          startFrame: m.frame,
          durationFrames: defaultDurFrames,
          text,
          fontSize: 36,
          position: "lower-third" as const,
        };
      });

    console.log(`  Titles: ${overlays.length} auto-generated from markers`);
    return overlays;
  }

  return [];
}

function main(): void {
  const { projectPath, sourceMapPath, titlesPath, autoTitles } = parseArgs();

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
  const { locatorMap: sourceMap, displayNameMap } = resolveSourceMap(projectPath, sourceMapPath);
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
    if (displayNameMap.size > 0) {
      console.log(`  Display names: ${displayNameMap.size} entries`);
    }
  }

  // Resolve text overlays
  const textOverlays = resolveTextOverlays(timeline, titlesPath, autoTitles);

  // Export
  const xml = timelineToFcp7Xml(timeline, {
    sourceMap,
    textOverlays,
    assetDisplayNameMap: displayNameMap.size > 0 ? displayNameMap : undefined,
    projectId: timeline.project_id,
  });

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
