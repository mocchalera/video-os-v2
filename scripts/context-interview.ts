#!/usr/bin/env tsx
/**
 * Collect client/editor context before analysis and write it into
 * 01_intent/creative_brief.yaml as context_knowledge.
 *
 *   npx tsx scripts/context-interview.ts --project projects/ena-promo-ai
 *   npx tsx scripts/context-interview.ts --project projects/ena-promo-ai --context context.yaml
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import * as readline from "node:readline/promises";
import { stdin as defaultInput, stdout as defaultOutput } from "node:process";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { validateArtifact } from "../runtime/artifacts/loaders.js";
import type { CreativeBrief } from "../runtime/artifacts/types.js";
import {
  normalizeContextKnowledge,
  type ContextKnowledge,
  type ContextKnowledgeKeyItem,
  type ContextKnowledgeSubject,
  type ContextKnowledgeTerminology,
} from "../runtime/context-knowledge.js";

const USAGE = "Usage: npx tsx scripts/context-interview.ts --project <projectDir> [--context <context.yaml>]";

export interface ContextInterviewArgs {
  projectDir: string;
  contextPath?: string;
}

interface WritableLike {
  write(chunk: string): unknown;
}

export function parseArgs(argv: string[] = process.argv): ContextInterviewArgs {
  const args = argv.slice(2);
  let projectDir: string | undefined;
  let contextPath: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") throw new Error(USAGE);
    if (arg === "--project") {
      projectDir = args[++index];
      if (!projectDir) throw new Error("--project requires a value");
      continue;
    }
    if (arg === "--context") {
      contextPath = args[++index];
      if (!contextPath) throw new Error("--context requires a value");
      continue;
    }
    if (arg.startsWith("--")) throw new Error(`Unknown argument: ${arg}`);
    if (!projectDir) {
      projectDir = arg;
      continue;
    }
    throw new Error(`Unexpected extra argument: ${arg}`);
  }

  if (!projectDir) throw new Error(USAGE);
  return { projectDir, contextPath };
}

function readYamlFile<T = unknown>(filePath: string): T {
  return parseYaml(fs.readFileSync(filePath, "utf-8")) as T;
}

function briefPathForProject(projectDir: string): string {
  return path.join(projectDir, "01_intent", "creative_brief.yaml");
}

function writeYamlAtomic(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, stringifyYaml(value), "utf-8");
  fs.renameSync(tmp, filePath);
}

function normalizeLoadedContext(value: unknown): ContextKnowledge {
  const root = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const candidate = root.context_knowledge ?? value;
  const normalized = normalizeContextKnowledge(candidate);
  if (!normalized) throw new Error("Context YAML did not contain any usable context_knowledge fields.");
  return normalized;
}

function marlinSceneSummaryLines(projectDir: string): string[] {
  const lines: string[] = [];
  const marlinPath = path.join(projectDir, "03_analysis", "marlin_events.json");
  if (fs.existsSync(marlinPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(marlinPath, "utf-8")) as {
        items?: Array<{ asset_id?: string; scene?: string; events?: Array<{ description?: string }> }>;
      };
      for (const item of parsed.items ?? []) {
        if (item.asset_id && item.scene) lines.push(`- ${item.asset_id}: ${item.scene}`);
        for (const event of (item.events ?? []).slice(0, 2)) {
          if (item.asset_id && event.description) lines.push(`  event: ${event.description}`);
        }
      }
    } catch {
      lines.push("- marlin_events.json exists but could not be parsed.");
    }
  }

  if (lines.length > 0) return lines.slice(0, 24);

  const segmentsPath = path.join(projectDir, "03_analysis", "segments.json");
  if (!fs.existsSync(segmentsPath)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(segmentsPath, "utf-8")) as {
      items?: Array<{ segment_id?: string; summary?: string }>;
    };
    return (parsed.items ?? [])
      .flatMap((item) => item.segment_id && item.summary ? [`- ${item.segment_id}: ${item.summary}`] : [])
      .slice(0, 24);
  } catch {
    return ["- segments.json exists but could not be parsed."];
  }
}

function printMarlinSceneSummaries(projectDir: string, output: WritableLike): void {
  const lines = marlinSceneSummaryLines(projectDir);
  if (lines.length === 0) {
    output.write("No Marlin or segment summaries found yet.\n\n");
    return;
  }
  output.write("Current AI scene summaries:\n");
  output.write(`${lines.join("\n")}\n\n`);
}

function splitRow(line: string, expected: number): string[] {
  return line
    .split("|")
    .map((part) => part.trim())
    .concat(Array.from({ length: expected }, () => ""))
    .slice(0, expected);
}

async function collectRows<T>(
  rl: readline.Interface,
  output: WritableLike,
  title: string,
  format: string,
  mapper: (parts: string[]) => T | undefined,
): Promise<T[]> {
  output.write(`${title}\n`);
  output.write(`Enter one per line as: ${format}\n`);
  output.write("Leave blank when done.\n");
  const rows: T[] = [];
  while (true) {
    const answer = (await rl.question("> ")).trim();
    if (!answer) break;
    const mapped = mapper(splitRow(answer, format.split("|").length));
    if (mapped) rows.push(mapped);
  }
  output.write("\n");
  return rows;
}

async function collectInteractiveContext(
  input: NodeJS.ReadableStream = defaultInput,
  output: WritableLike = defaultOutput,
): Promise<ContextKnowledge> {
  const rl = readline.createInterface({ input, output: output as NodeJS.WritableStream });
  try {
    const primaryLocation = (await rl.question("Where was this filmed? Primary location: ")).trim();
    const specificPlaces = await collectRows(
      rl,
      output,
      "Any specific locations?",
      "name | description",
      ([name, description]) => name ? { name, ...(description ? { description } : {}) } : undefined,
    );
    const subjects = await collectRows<ContextKnowledgeSubject>(
      rl,
      output,
      "Who appears in the footage?",
      "name | role | appearance",
      ([name, role, appearance]) => name
        ? {
          name,
          ...(role ? { role } : {}),
          ...(appearance ? { appearance } : {}),
        }
        : undefined,
    );
    const keyItems = await collectRows<ContextKnowledgeKeyItem>(
      rl,
      output,
      "Any specific items, products, foods, or tools that appear?",
      "name | description | significance",
      ([name, description, significance]) => name
        ? {
          name,
          ...(description ? { description } : {}),
          ...(significance ? { significance } : {}),
        }
        : undefined,
    );
    const culturalContext = (await rl.question("Any cultural context the AI should know? ")).trim();
    output.write("Any terms that might be misidentified? Use examples from the AI summaries above.\n");
    const terminology = await collectRows<ContextKnowledgeTerminology>(
      rl,
      output,
      "Terminology",
      "term | meaning",
      ([term, meaning]) => term
        ? {
          term,
          ...(meaning ? { meaning } : {}),
        }
        : undefined,
    );

    const normalized = normalizeContextKnowledge({
      location: {
        ...(primaryLocation ? { primary_location: primaryLocation } : {}),
        ...(specificPlaces.length > 0 ? { specific_places: specificPlaces } : {}),
      },
      ...(subjects.length > 0 ? { subjects } : {}),
      ...(keyItems.length > 0 ? { key_items: keyItems } : {}),
      ...(culturalContext ? { cultural_context: culturalContext } : {}),
      ...(terminology.length > 0 ? { terminology } : {}),
    });
    if (!normalized) throw new Error("No context was entered.");
    return normalized;
  } finally {
    rl.close();
  }
}

export async function runContextInterview(
  args: ContextInterviewArgs,
  options: {
    input?: NodeJS.ReadableStream;
    output?: WritableLike;
  } = {},
): Promise<string> {
  const projectDir = path.resolve(args.projectDir);
  const output = options.output ?? defaultOutput;
  const briefPath = briefPathForProject(projectDir);
  if (!fs.existsSync(briefPath)) {
    throw new Error(`creative_brief.yaml not found: ${briefPath}`);
  }

  const brief = readYamlFile<Record<string, unknown>>(briefPath);
  validateArtifact<CreativeBrief>(brief, "creative-brief.schema.json");
  printMarlinSceneSummaries(projectDir, output);

  const context = args.contextPath
    ? normalizeLoadedContext(readYamlFile(path.resolve(args.contextPath)))
    : await collectInteractiveContext(options.input, output);

  brief.context_knowledge = context;
  validateArtifact<CreativeBrief>(brief, "creative-brief.schema.json");
  writeYamlAtomic(briefPath, brief);
  output.write(`Wrote context_knowledge to ${briefPath}\n`);
  return briefPath;
}

export async function main(argv: string[] = process.argv): Promise<number> {
  let args: ContextInterviewArgs;
  try {
    args = parseArgs(argv);
    await runContextInterview(args);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

const isDirectRun =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
