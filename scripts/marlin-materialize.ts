#!/usr/bin/env npx tsx
import { config as dotenvConfig } from "dotenv";
dotenvConfig({ path: ".env.local" });
dotenvConfig();

import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { MarlinEventsArtifact } from "../runtime/connectors/marlin-types.js";
import {
  applyMarlinEventsToSegments,
  MARLIN_EVENTS_RELATIVE_PATH,
} from "../runtime/pipeline/stages/marlin.js";

interface SegmentDoc {
  items?: SegmentDocItem[];
}

interface SegmentDocItem {
  peak_analysis?: {
    peak_moments?: Array<{
      source_pass?: string;
    }>;
    provenance?: {
      precision_mode?: string;
      fusion_version?: string;
    };
  };
}

export interface MarlinMaterializeOptions {
  projectDir: string;
  repoRoot?: string;
}

export interface MarlinMaterializeResult {
  projectDir: string;
  artifactPath: string;
  changed: boolean;
  segmentCount: number;
  marlinPeaksBefore: number;
  marlinPeaksAfter: number;
  marlinEventCount: number;
  marlinFindResultCount: number;
}

export function parseArgs(argv: string[]): MarlinMaterializeOptions {
  const args = argv.slice(2);
  let projectDir = "";
  let repoRoot: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--project" || arg === "-p") {
      projectDir = args[++index] ?? "";
    } else if (arg === "--repo-root") {
      repoRoot = args[++index] ?? undefined;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else if (!arg.startsWith("-") && !projectDir) {
      projectDir = arg;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!projectDir) {
    throw new Error("--project <project-dir> is required");
  }

  return { projectDir, repoRoot };
}

export function runMarlinMaterialize(options: MarlinMaterializeOptions): MarlinMaterializeResult {
  const projectDir = path.resolve(options.projectDir);
  const artifactPath = path.join(projectDir, MARLIN_EVENTS_RELATIVE_PATH);
  const artifact = readJson<MarlinEventsArtifact>(artifactPath, "Marlin events artifact");
  const before = readSegments(projectDir);

  const changed = applyMarlinEventsToSegments(projectDir, artifact);
  const after = readSegments(projectDir);

  return {
    projectDir,
    artifactPath,
    changed,
    segmentCount: after.items?.length ?? 0,
    marlinPeaksBefore: countMarlinPeaks(before),
    marlinPeaksAfter: countMarlinPeaks(after),
    marlinEventCount: artifact.items.reduce((count, item) => count + item.events.length, 0),
    marlinFindResultCount: artifact.items.reduce((count, item) => count + item.find_results.length, 0),
  };
}

function readSegments(projectDir: string): SegmentDoc {
  return readJson<SegmentDoc>(
    path.join(projectDir, "03_analysis/segments.json"),
    "segments artifact",
  );
}

function readJson<T>(filePath: string, label: string): T {
  if (!fs.existsSync(filePath)) {
    throw new Error(`${label} not found: ${filePath}`);
  }
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
}

function countMarlinPeaks(segments: SegmentDoc): number {
  return (segments.items ?? []).filter((segment) => isMarlinPeak(segment.peak_analysis)).length;
}

function isMarlinPeak(peakAnalysis: SegmentDocItem["peak_analysis"]): boolean {
  const provenance = peakAnalysis?.provenance;
  if (provenance?.precision_mode === "marlin_temporal_semantics") return true;
  if (provenance?.fusion_version?.startsWith("marlin")) return true;
  return peakAnalysis?.peak_moments?.some((peak) => peak.source_pass?.startsWith("marlin_")) ?? false;
}

function printHelp(): void {
  console.log(`Usage: npx tsx scripts/marlin-materialize.ts --project <project-dir>

Options:
  --project, -p  Project directory with existing 03_analysis artifacts
  --repo-root    Repository root for parity with other Marlin CLIs
  --help, -h     Show this help

Reads 03_analysis/marlin_events.json and materializes existing Marlin evidence
into 03_analysis/segments.json without running the Marlin model.
`);
}

const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isMain) {
  try {
    const result = runMarlinMaterialize(parseArgs(process.argv));
    console.log("[marlin-materialize] complete");
    console.log(`  Project: ${path.basename(result.projectDir)}`);
    console.log(`  Artifact: ${result.artifactPath}`);
    console.log(`  Changed: ${result.changed}`);
    console.log(`  Segments: ${result.segmentCount}`);
    console.log(`  Marlin peaks before: ${result.marlinPeaksBefore}`);
    console.log(`  Marlin peaks after: ${result.marlinPeaksAfter}`);
    console.log(`  Marlin events: ${result.marlinEventCount}`);
    console.log(`  Marlin find results: ${result.marlinFindResultCount}`);
  } catch (error) {
    console.error("[marlin-materialize] failed:", error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
