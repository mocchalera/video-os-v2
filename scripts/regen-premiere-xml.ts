#!/usr/bin/env npx tsx
/**
 * Regenerate Premiere Pro XML for all projects that have timeline.json.
 *
 * Scans projects/ for directories containing 05_timeline/timeline.json,
 * then runs the FCP7 XML exporter for each.
 *
 * Usage:
 *   npx tsx scripts/regen-premiere-xml.ts          # all projects
 *   npx tsx scripts/regen-premiere-xml.ts my-proj   # single project
 *
 * This script should be run after modifying runtime/handoff/fcp7-xml-export.ts
 * to keep all project outputs in sync with the exporter.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { TimelineIR } from "../runtime/compiler/types.js";
import {
  timelineToFcp7Xml,
  type TextOverlay,
} from "../runtime/handoff/fcp7-xml-export.js";
import { loadSourceMap } from "../runtime/media/source-map.js";

const PROJECTS_DIR = path.resolve("projects");

interface ProjectExportConfig {
  projectPath: string;
  projectId: string;
  timelinePath: string;
  sourceMapPath?: string;
  titlesPath?: string;
}

function discoverProjects(filter?: string): ProjectExportConfig[] {
  const configs: ProjectExportConfig[] = [];

  if (!fs.existsSync(PROJECTS_DIR)) return configs;

  const dirs = filter
    ? [filter]
    : fs.readdirSync(PROJECTS_DIR).filter((d) =>
        fs.statSync(path.join(PROJECTS_DIR, d)).isDirectory(),
      );

  for (const dir of dirs) {
    const projectPath = path.join(PROJECTS_DIR, dir);
    const timelinePath = path.join(
      projectPath,
      "05_timeline",
      "timeline.json",
    );
    if (!fs.existsSync(timelinePath)) continue;

    // Look for source map (multiple candidate locations)
    const sourceMapCandidates = [
      path.join(projectPath, "source-map.json"),
      path.join(projectPath, "02_media", "source_map.json"),
    ];
    const sourceMapPath = sourceMapCandidates.find((p) => fs.existsSync(p));

    // Look for titles definition
    const titlesCandidates = [
      path.join(projectPath, "titles.json"),
      path.join(projectPath, "09_output", "titles.json"),
    ];
    const titlesPath = titlesCandidates.find((p) => fs.existsSync(p));

    configs.push({
      projectPath,
      projectId: dir,
      timelinePath,
      sourceMapPath,
      titlesPath,
    });
  }

  return configs;
}

function exportProject(config: ProjectExportConfig): string | null {
  const timeline: TimelineIR = JSON.parse(
    fs.readFileSync(config.timelinePath, "utf-8"),
  );

  // Resolve source map
  const loaded = loadSourceMap(config.projectPath, config.sourceMapPath);
  if (loaded.locatorMap.size === 0) {
    console.log(`  [skip] no source map`);
    return null;
  }

  // Resolve text overlays
  let textOverlays: TextOverlay[] | undefined;
  if (config.titlesPath) {
    const raw = JSON.parse(fs.readFileSync(config.titlesPath, "utf-8"));
    textOverlays = Array.isArray(raw) ? raw : raw.overlays;
  }

  // Generate XML
  const xml = timelineToFcp7Xml(timeline, {
    sourceMap: loaded.locatorMap,
    textOverlays,
    projectId: timeline.project_id,
  });

  // Write output
  const outputDir = path.join(config.projectPath, "09_output");
  fs.mkdirSync(outputDir, { recursive: true });

  const outputPath = path.join(
    outputDir,
    `${timeline.project_id}_premiere.xml`,
  );
  fs.writeFileSync(outputPath, xml, "utf-8");

  return outputPath;
}

// ── Main ────────────────────────────────────────────────────────────

function main(): void {
  const filter = process.argv[2];

  console.log("Regenerating Premiere Pro XML...");
  const configs = discoverProjects(filter);

  if (configs.length === 0) {
    console.log("No projects with timeline.json found.");
    return;
  }

  let exported = 0;
  let skipped = 0;

  for (const config of configs) {
    process.stdout.write(`  ${config.projectId}: `);
    const result = exportProject(config);
    if (result) {
      const clips =
        JSON.parse(fs.readFileSync(config.timelinePath, "utf-8")) as TimelineIR;
      const totalClips =
        clips.tracks.video.reduce((n, t) => n + t.clips.length, 0) +
        clips.tracks.audio.reduce((n, t) => n + t.clips.length, 0);
      const hasTitles = config.titlesPath ? " + titles" : "";
      console.log(
        `${totalClips} clips${hasTitles} → ${path.relative(".", result)}`,
      );
      exported++;
    } else {
      skipped++;
    }
  }

  console.log(
    `\nDone: ${exported} exported, ${skipped} skipped`,
  );
}

main();
