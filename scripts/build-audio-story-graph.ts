#!/usr/bin/env npx tsx
import { pathToFileURL } from "node:url";
import { buildProjectAudioStoryGraph } from "../runtime/artifacts/audio-story-project-builder.js";

function parseArgs(argv: string[]): { projectDir: string; write: boolean } {
  const args = argv.slice(2);
  let projectDir = "";
  let write = true;
  for (const arg of args) {
    if (arg === "--no-write" || arg === "--dry-run") {
      write = false;
    } else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else if (!arg.startsWith("-") && !projectDir) {
      projectDir = arg;
    } else {
      console.error(`Unknown argument: ${arg}`);
      printUsage();
      process.exit(2);
    }
  }
  if (!projectDir) {
    printUsage();
    process.exit(2);
  }
  return { projectDir, write };
}

function printUsage(): void {
  console.log("Usage: npx tsx scripts/build-audio-story-graph.ts <project-dir> [--no-write]");
}

export function printAudioStoryGraphSummary(result: ReturnType<typeof buildProjectAudioStoryGraph>): void {
  console.log(`project: ${result.projectId}`);
  console.log(`status: ${result.status}`);
  console.log(`written: ${result.written}`);
  console.log(`graph: ${result.graphPath}`);
  console.log(`nodes: ${result.nodeCount}`);
  console.log(`previousNodes: ${result.previousNodeCount}`);
  console.log(`edges: ${result.edgeCount}`);
  console.log(`dialogueNodes: ${result.dialogueNodeCount}`);
  console.log(`audioEventNodes: ${result.audioEventNodeCount}`);
  console.log(`musicNodes: ${result.musicNodeCount}`);
  console.log(`missingInputs: ${result.missingInputs.length > 0 ? result.missingInputs.join(",") : "-"}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const result = buildProjectAudioStoryGraph({
    projectDir: args.projectDir,
    write: args.write,
  });
  printAudioStoryGraphSummary(result);
}

const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isMain) {
  main().catch((error) => {
    console.error(`audio story graph failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
